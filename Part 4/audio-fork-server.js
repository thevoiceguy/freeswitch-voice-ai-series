// audio-fork-server.js (Part 4 — closed loop voice agent, uuid_broadcast playback)
//
// Caller speaks → Deepgram STT → OpenAI streaming → Deepgram TTS → caller hears.
// Playback path: Node writes a .wav file then asks FreeSWITCH to play it via
// the Event Socket's uuid_broadcast command.
//
// Reads from process.env: DEEPGRAM_API_KEY, OPENAI_API_KEY, FS_ESL_PASSWORD

const fs = require('fs');
const { WebSocketServer } = require('ws');
const { DeepgramClient } = require('@deepgram/sdk');
const OpenAI = require('openai');
const esl = require('modesl');

const PORT        = 8080;
const SAMPLE_RATE = 8000;
const CHANNELS    = 1;

const DG_KEY     = process.env.DEEPGRAM_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ESL_PASS   = process.env.FS_ESL_PASSWORD;

if (!DG_KEY)     { console.error('ERROR: DEEPGRAM_API_KEY not set.'); process.exit(1); }
if (!OPENAI_KEY) { console.error('ERROR: OPENAI_API_KEY not set.');   process.exit(1); }
if (!ESL_PASS)   { console.error('ERROR: FS_ESL_PASSWORD not set.');  process.exit(1); }

const deepgram = new DeepgramClient({ apiKey: DG_KEY });
const openai   = new OpenAI({ apiKey: OPENAI_KEY });
const wss      = new WebSocketServer({ port: PORT });

const SYSTEM_PROMPT =
  'You are a helpful voice agent. Keep responses brief and conversational — ' +
  'typically 1-2 sentences. Speak naturally as if on a phone call. ' +
  'Avoid markdown, lists, or formatting.';

const GREETING = 'Hi there! How can I help you today?';

// ----- Shared ESL connection ---------------------------------------------
let eslConn = null;
let eslReady = false;

function connectEsl() {
  return new Promise((resolve, reject) => {
    const conn = new esl.Connection('127.0.0.1', 8021, ESL_PASS, () => {
      console.log('ESL connected to FreeSWITCH');
      conn.events('plain', 'PLAYBACK_STOP CHANNEL_HANGUP', () => {
        eslConn = conn;
        eslReady = true;
        resolve(conn);
      });
    });
    conn.on('error', (err) => {
      console.error('ESL error:', err);
      eslReady = false;
      reject(err);
    });
  });
}

function eslBgapi(cmd) {
  return new Promise((resolve, reject) => {
    if (!eslReady) return reject(new Error('ESL not ready'));
    eslConn.bgapi(cmd, (res) => resolve(res?.getBody?.() || ''));
  });
}

// ----- WAV writer --------------------------------------------------------
function writeWav(filepath, pcm, rate, channels, bits) {
  const byteRate   = rate * channels * (bits / 8);
  const blockAlign = channels * (bits / 8);
  const header     = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  fs.writeFileSync(filepath, Buffer.concat([header, pcm]));
}

// ----- Synthesize one phrase to a WAV ------------------------------------
async function synthesizePhraseToWav(text, callId, turnN, phraseN) {
  const tts = await deepgram.speak.v1.connect({
    model:       'aura-2-thalia-en',
    encoding:    'linear16',
    sample_rate: SAMPLE_RATE,
  });

  const audioChunks = [];
  let resolveFlushed;
  const flushedPromise = new Promise(r => { resolveFlushed = r; });

  tts.on('open', () => {
    tts.socket.addEventListener('message', async (event) => {
      const data = event.data;
      if (data instanceof Blob) {
        audioChunks.push(Buffer.from(await data.arrayBuffer()));
      } else if (typeof data === 'string') {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'Flushed') {
            tts.socket.close();
            resolveFlushed();
          }
        } catch {}
      }
    });
  });

  tts.on('error', (err) => console.error(`[${callId}] TTS error:`, err));

  tts.connect();
  await tts.waitForOpen();

  tts.socket.send(JSON.stringify({ type: 'Speak', text }));
  tts.socket.send(JSON.stringify({ type: 'Flush' }));

  await flushedPromise;

  const wavPath = `/tmp/agent-${callId}-${turnN}-${phraseN}.wav`;
  writeWav(wavPath, Buffer.concat(audioChunks), SAMPLE_RATE, CHANNELS, 16);
  return wavPath;
}

// ----- Per-call playback queue -------------------------------------------
function makePlaybackQueue(callId, channelUuid) {
  const playableQueue = [];
  const waiting       = new Map();
  let playing      = false;
  let pendingSynth = 0;
  let nextExpected = 1;
  let onIdle       = null;

  function checkIdle() {
    if (!playing &&
        playableQueue.length === 0 &&
        pendingSynth === 0 &&
        waiting.size === 0 &&
        onIdle) {
      const cb = onIdle;
      onIdle = null;
      cb();
    }
  }

  function drainWaiting() {
    while (waiting.has(nextExpected)) {
      const entry = waiting.get(nextExpected);
      waiting.delete(nextExpected);
      playableQueue.push(entry);
      nextExpected++;
    }
  }

  async function broadcastAndWait(wavPath) {
    const playbackComplete = new Promise((resolve) => {
      const listener = (evt) => {
        const evtUuid = evt.getHeader('Unique-ID');
        if (evtUuid !== channelUuid) return;
        const evtFile =
          evt.getHeader('Playback-File-Path') ||
          evt.getHeader('File-Path') ||
          evt.getHeader('Application-Data') ||
          '';
        if (evtFile.includes(wavPath)) {
          eslConn.removeListener('esl::event::PLAYBACK_STOP::*', listener);
          resolve();
        }
      };
      eslConn.on('esl::event::PLAYBACK_STOP::*', listener);
    });

    await eslBgapi(`uuid_broadcast ${channelUuid} ${wavPath} aleg`);
    await playbackComplete;
    fs.unlink(wavPath, () => {});
  }

  async function loop() {
    playing = true;
    while (playableQueue.length > 0) {
      const { wavPath, onPlayStart } = playableQueue.shift();
      if (onPlayStart) onPlayStart();
      await broadcastAndWait(wavPath);
    }
    playing = false;
    checkIdle();
  }

  return {
    reservePhrase() {
      pendingSynth++;
    },
    enqueue(phraseN, wavPath, onPlayStart) {
      pendingSynth--;
      waiting.set(phraseN, { wavPath, onPlayStart });
      drainWaiting();
      if (!playing && playableQueue.length > 0) loop();
    },
    cancelPhrase(phraseN) {
      pendingSynth--;
      if (phraseN === nextExpected) {
        nextExpected++;
        drainWaiting();
      }
      checkIdle();
    },
    waitUntilIdle() {
      return new Promise((resolve) => {
        if (!playing &&
            playableQueue.length === 0 &&
            pendingSynth === 0 &&
            waiting.size === 0) {
          return resolve();
        }
        onIdle = resolve;
      });
    },
    resetPhraseCursor() {
      nextExpected = 1;
      waiting.clear();
    },
  };
}

// ----- Boot --------------------------------------------------------------
(async () => {
  await connectEsl();
  console.log(`Listening for FreeSWITCH audio on ws://0.0.0.0:${PORT}`);
  console.log(`Deepgram client initialized (SDK v5).`);
  console.log(`OpenAI client initialized.`);
})().catch(err => {
  console.error('Boot failed:', err.message);
  process.exit(1);
});

// ----- Per-call handler --------------------------------------------------
wss.on('connection', async (ws, req) => {
  const callId = `call-${Date.now()}`;
  console.log(`\n[${callId}] FreeSWITCH connected from ${req.socket.remoteAddress}`);

  const conversation = [{ role: 'system', content: SYSTEM_PROMPT }];
  let turnNumber       = 0;
  let speaking         = false;
  let currentTurn      = null;
  let channelUuid      = null;
  let dgSttReady       = false;
  let playbackQueue    = null;
  let pendingUtterance = null;
  let utteranceBuf     = '';

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'start' && msg.uuid) {
          channelUuid = msg.uuid;
          playbackQueue = makePlaybackQueue(callId, channelUuid);
          console.log(`[${callId}] channel UUID: ${channelUuid}`);
        }
      } catch {}
      return;
    }
    if (dgSttReady && dgStt.socket?.readyState === 1) {
      dgStt.socket.send(data);
    }
  });

  const dgStt = await deepgram.listen.v1.connect({
    model:            'nova-3',
    encoding:         'linear16',
    sample_rate:      SAMPLE_RATE,
    channels:         CHANNELS,
    punctuate:        true,
    interim_results:  true,
    endpointing:      300,
    utterance_end_ms: 1000,
    vad_events:       true,
    smart_format:     false,
  });

  dgStt.on('open', () => {
    console.log(`[${callId}] Deepgram STT opened`);
    dgSttReady = true;
  });

  dgStt.on('message', async (data) => {
    if (data.type === 'UtteranceEnd') {
      if (!utteranceBuf.trim()) return;
      const fullUtterance = utteranceBuf.trim();
      utteranceBuf = '';

      console.log(`[${callId}] UTTERANCE: "${fullUtterance}"`);

      if (!channelUuid) return;
      if (speaking) {
        console.log(`[${callId}]   (queued — agent still speaking)`);
        pendingUtterance = fullUtterance;
        return;
      }

      await handleUserTurn(fullUtterance);
      while (pendingUtterance && !speaking) {
        const next = pendingUtterance;
        pendingUtterance = null;
        console.log(`[${callId}] processing queued: "${next}"`);
        await handleUserTurn(next);
      }
      return;
    }

    if (data.type !== 'Results') return;
    const transcript = data.channel?.alternatives?.[0]?.transcript;
    if (!transcript) return;

    if (data.is_final) {
      utteranceBuf += (utteranceBuf ? ' ' : '') + transcript;
      console.log(`[${callId}] (final fragment): "${transcript}"`);
    } else {
      console.log(`[${callId}] interim: "${transcript}"`);
    }
  });

  dgStt.on('error', (err) => console.error(`[${callId}] STT error:`, err));
  dgStt.on('close', () => console.log(`[${callId}] STT closed`));

  dgStt.connect();
  try {
    await dgStt.waitForOpen();
  } catch (err) {
    console.error(`[${callId}] STT failed to open:`, err.message);
    ws.close();
    return;
  }

  // Wait briefly for the channel UUID metadata to arrive before greeting
  await new Promise(r => setTimeout(r, 200));
  await speakResponse(GREETING, /*isGreeting=*/ true);

  async function handleUserTurn(userText) {
    turnNumber++;
    currentTurn = {
      n: turnNumber, startedAt: Date.now(),
      llmFirstAt: null, firstPlayStartAt: null,
      completedAt: null, phraseCount: 0,
    };
    console.log(`[${callId}] turn ${turnNumber} start`);

    playbackQueue.resetPhraseCursor();

    conversation.push({ role: 'user', content: userText });
    speaking = true;

    let fullResponse = '';

    try {
      const stream = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: conversation,
        stream: true,
      });

      let phraseBuf = '';

      for await (const chunk of stream) {
        if (!currentTurn.llmFirstAt) {
          currentTurn.llmFirstAt = Date.now();
          const dt = currentTurn.llmFirstAt - currentTurn.startedAt;
          console.log(`[${callId}]   LLM first token at +${dt}ms`);
        }
        const delta = chunk.choices?.[0]?.delta?.content;
        if (!delta) continue;

        phraseBuf    += delta;
        fullResponse += delta;

        if (/[.!?]$/.test(phraseBuf.trim()) ||
            (/,$/.test(phraseBuf.trim()) && phraseBuf.length > 40)) {
          shipPhrase(phraseBuf.trim());
          phraseBuf = '';
        }
      }
      if (phraseBuf.trim()) shipPhrase(phraseBuf.trim());

      conversation.push({ role: 'assistant', content: fullResponse });

      const MAX_TURNS = 10;
      while (conversation.length > MAX_TURNS * 2 + 1) {
        conversation.splice(1, 2);
      }

      await playbackQueue.waitUntilIdle();
      currentTurn.completedAt = Date.now();
      const total = currentTurn.completedAt - currentTurn.startedAt;
      console.log(`[${callId}] turn ${turnNumber} complete (${total}ms total)`);
      speaking = false;
    } catch (err) {
      console.error(`[${callId}] turn ${turnNumber} error:`, err.message);
      speaking = false;
      currentTurn = null;
    }
  }

  function shipPhrase(text) {
    if (!currentTurn) return;
    currentTurn.phraseCount++;
    const phraseN = currentTurn.phraseCount;
    const turnRef = currentTurn;

    playbackQueue.reservePhrase();

    synthesizePhraseToWav(text, callId, turnRef.n, phraseN)
      .then((wavPath) => {
        playbackQueue.enqueue(phraseN, wavPath, () => {
          if (!turnRef.firstPlayStartAt) {
            turnRef.firstPlayStartAt = Date.now();
            const dt = turnRef.firstPlayStartAt - turnRef.startedAt;
            console.log(`[${callId}]   first audio playing at +${dt}ms`);
          }
        });
      })
      .catch((err) => {
        console.error(`[${callId}] phrase ${phraseN} synth failed:`, err.message);
        playbackQueue.cancelPhrase(phraseN);
      });
  }

  async function speakResponse(text, isGreeting = false) {
    if (isGreeting) {
      turnNumber++;
      currentTurn = {
        n: turnNumber, startedAt: Date.now(),
        llmFirstAt: Date.now(),
        firstPlayStartAt: null, completedAt: null, phraseCount: 0,
      };
      console.log(`[${callId}] turn ${turnNumber} (greeting) start`);
    }

    playbackQueue.resetPhraseCursor();
    speaking = true;

    shipPhrase(text);
    if (!isGreeting) conversation.push({ role: 'assistant', content: text });

    await playbackQueue.waitUntilIdle();
    currentTurn.completedAt = Date.now();
    const total = currentTurn.completedAt - currentTurn.startedAt;
    console.log(`[${callId}] turn ${currentTurn.n} complete (${total}ms total)`);
    speaking = false;
  }

  ws.on('close', () => {
    console.log(`[${callId}] FreeSWITCH connection closed`);
    if (dgStt.socket?.readyState === 1) dgStt.socket.close();
  });

  ws.on('error', (err) => console.error(`[${callId}] WebSocket error:`, err.message));
});
