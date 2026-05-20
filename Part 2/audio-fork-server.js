// audio-fork-server.js
//
// Minimal WebSocket server for receiving forked call audio from
// FreeSWITCH's mod_audio_fork. Writes the received audio to a .wav
// file you can play back to confirm the plumbing works.
//
// Usage:
//   npm init -y
//   npm install ws
//   node audio-fork-server.js
//
// Then make a test call. When the call ends, look for the .wav file
// in the current directory and play it back.

const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// --- config ---------------------------------------------------------------
// Match these to what your dialplan tells mod_audio_fork to send.
// Part 2 uses 8 kHz mono linear PCM (matches the call's native rate).
const PORT        = 8080;
const SAMPLE_RATE = 8000;   // Hz
const CHANNELS    = 1;      // mono
const BITS_PER_SAMPLE = 16; // linear PCM

// --- server ---------------------------------------------------------------
const wss = new WebSocketServer({ port: PORT });
console.log(`Listening for FreeSWITCH audio fork on ws://0.0.0.0:${PORT}`);

wss.on('connection', (ws, req) => {
  // Each call gets its own file, named with a timestamp.
  const filename = `call-${Date.now()}.raw`;
  const filepath = path.resolve(filename);
  const stream = fs.createWriteStream(filepath);
  let bytesReceived = 0;

  console.log(`[${filename}] connection from ${req.socket.remoteAddress}`);

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      // mod_audio_fork sends a JSON metadata frame on connect; log it.
      console.log(`[${filename}] text frame: ${data.toString().slice(0, 200)}`);
      return;
    }
    stream.write(data);
    bytesReceived += data.length;
  });

  ws.on('close', () => {
    stream.end(() => {
      const wavPath = filepath.replace(/\.raw$/, '.wav');
      writeWav(filepath, wavPath, SAMPLE_RATE, CHANNELS, BITS_PER_SAMPLE);
      const seconds = bytesReceived / (SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8));
      console.log(
        `[${filename}] closed: ${bytesReceived} bytes ` +
        `(${seconds.toFixed(1)}s of audio) → ${wavPath}`
      );
    });
  });

  ws.on('error', (err) => console.error(`[${filename}] error:`, err.message));
});

// --- WAV writer -----------------------------------------------------------
// Wrap raw PCM in a minimal RIFF/WAVE header so the file plays in any
// standard audio player (aplay, afplay, VLC, etc).
function writeWav(rawPath, wavPath, rate, channels, bits) {
  const pcm = fs.readFileSync(rawPath);
  const byteRate   = rate * channels * (bits / 8);
  const blockAlign = channels * (bits / 8);
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);            // fmt chunk size
  header.writeUInt16LE(1, 20);             // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  fs.writeFileSync(wavPath, Buffer.concat([header, pcm]));
}
