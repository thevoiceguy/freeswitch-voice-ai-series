// audio-fork-server.js (Part 3, Deepgram SDK v5)
//
// Receives streamed call audio from FreeSWITCH's mod_audio_stream and
// forwards it to Deepgram's streaming STT API. Logs interim and final
// transcripts to the console as the caller speaks.
//
// Reads the Deepgram API key from process.env.DEEPGRAM_API_KEY.

const { WebSocketServer } = require('ws');
const { DeepgramClient } = require('@deepgram/sdk');

const PORT        = 8080;
const SAMPLE_RATE = 8000;   // Hz, must match the dialplan
const CHANNELS    = 1;       // mono

const apiKey = process.env.DEEPGRAM_API_KEY;
if (!apiKey) {
  console.error('ERROR: DEEPGRAM_API_KEY environment variable not set.');
  console.error('Run: export DEEPGRAM_API_KEY="your-key-here"');
  process.exit(1);
}

const deepgram = new DeepgramClient({ apiKey });
const wss      = new WebSocketServer({ port: PORT });

console.log(`Listening for FreeSWITCH audio on ws://0.0.0.0:${PORT}`);
console.log(`Deepgram client initialized (SDK v5).`);

wss.on('connection', async (ws, req) => {
  const callId = `call-${Date.now()}`;
  console.log(`[${callId}] FreeSWITCH connected from ${req.socket.remoteAddress}`);

  // listen.v1.connect() returns a Promise that resolves to a
  // WrappedListenV1Socket. Await it before attaching listeners.
  const dgConnection = await deepgram.listen.v1.connect({
    model:           'nova-3',
    encoding:        'linear16',
    sample_rate:     SAMPLE_RATE,
    channels:        CHANNELS,
    punctuate:       true,
    interim_results: true,
    endpointing:     300,    // ms of silence before declaring an utterance done
    smart_format:    true,
  });

  let dgReady = false;

  dgConnection.on('open', () => {
    console.log(`[${callId}] Deepgram connection opened`);
    dgReady = true;
  });

  dgConnection.on('message', (data) => {
    if (data.type !== 'Results') return;

    const transcript = data.channel?.alternatives?.[0]?.transcript;
    if (!transcript) return;

    if (data.is_final) {
      console.log(`[${callId}] FINAL:   "${transcript}"`);
    } else {
      console.log(`[${callId}] interim: "${transcript}"`);
    }
  });

  dgConnection.on('error', (err) => {
    console.error(`[${callId}] Deepgram error:`, err);
  });

  dgConnection.on('close', () => {
    console.log(`[${callId}] Deepgram connection closed`);
    dgReady = false;
  });

  // Open the WebSocket and wait until Deepgram says it's ready.
  dgConnection.connect();
  try {
    await dgConnection.waitForOpen();
  } catch (err) {
    console.error(`[${callId}] Failed to open Deepgram connection:`, err.message);
    ws.close();
    return;
  }

  // Forward each binary audio frame from FreeSWITCH to Deepgram.
  // Sending goes through the underlying .socket — the wrapper itself
  // doesn't expose a send() method.
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      console.log(`[${callId}] text frame: ${data.toString().slice(0, 200)}`);
      return;
    }
    if (dgReady && dgConnection.socket?.readyState === 1 /* OPEN */) {
      dgConnection.socket.send(data);
    }
  });

  ws.on('close', () => {
    console.log(`[${callId}] FreeSWITCH connection closed`);
    if (dgConnection.socket?.readyState === 1) {
      dgConnection.socket.close();
    }
  });

  ws.on('error', (err) => {
    console.error(`[${callId}] WebSocket error:`, err.message);
  });
});
