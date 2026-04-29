import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8443);
const SAMPLE_RATE = Number(process.env.SAMPLE_RATE || 48000);
const CHANNELS = Number(process.env.CHANNELS || 1);
const RTSP_URL = process.env.RTSP_URL || 'rtsp://127.0.0.1:554/iphone-mic';
const STREAM_MODE = process.env.STREAM_MODE || 'black-video';
const OUTPUT_AUDIO_RATE = Number(process.env.OUTPUT_AUDIO_RATE || 8000);
const RNNOISE_MODEL_PATH = process.env.RNNOISE_MODEL_PATH || path.join(__dirname, 'models', 'std.rnnn');
const RNNOISE_MIX = process.env.RNNOISE_MIX || '0.85';
const AI_DENOISE = process.env.AI_DENOISE === 'true';
const MIC_GAIN = process.env.MIC_GAIN || '0.45';
const GATE_THRESHOLD = process.env.GATE_THRESHOLD || '0.03';
const DEFAULT_SPEECH_FILTER = AI_DENOISE
  ? `highpass=f=120,lowpass=f=3600,arnndn=m='${RNNOISE_MODEL_PATH}':mix=${RNNOISE_MIX},compand=attacks=0.02:decays=0.25:points=-80/-80|-45/-45|-20/-12|0/-4:soft-knee=6:gain=4`
  : 'volume=1.0';
const SPEECH_FILTER = process.env.SPEECH_FILTER || DEFAULT_SPEECH_FILTER;
const IDLE_STREAM = process.env.IDLE_STREAM !== 'false';
const CERT_PATH = process.env.CERT_PATH || path.join(__dirname, 'certs', 'server.crt');
const KEY_PATH = process.env.KEY_PATH || path.join(__dirname, 'certs', 'server.key');

let ffmpeg = null;
let ffmpegMode = null;
let activeClient = null;
let bytesReceived = 0;
let startedAt = null;
let lastAudioPeakDb = null;
let lastAudioRmsDb = null;

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }

  return addresses;
}

function contentTypeFor(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function serveStatic(req, res) {
  const publicDir = path.join(__dirname, 'public');
  const requestedPath = new URL(req.url, `https://${req.headers.host}`).pathname;

  if (requestedPath === '/status') {
    const uptimeSeconds = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      connected: Boolean(activeClient),
      ffmpegRunning: Boolean(ffmpeg),
      bytesReceived,
      uptimeSeconds,
      rtspUrl: RTSP_URL,
      streamMode: STREAM_MODE,
      ffmpegMode,
      audioPeakDb: lastAudioPeakDb,
      audioRmsDb: lastAudioRmsDb
    }));
    return;
  }

  const relativePath = requestedPath === '/' ? '/index.html' : requestedPath;
  const filePath = path.normalize(path.join(publicDir, relativePath));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    res.writeHead(200, { 'content-type': contentTypeFor(filePath) });
    res.end(data);
  });
}

function buildLiveFfmpegArgs() {
  const audioInput = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-f', 's16le',
    '-ar', String(SAMPLE_RATE),
    '-ac', String(CHANNELS),
    '-i', 'pipe:0'
  ];

  if (STREAM_MODE === 'audio-only') {
    return [
      ...audioInput,
      '-af', SPEECH_FILTER,
      '-c:a', 'pcm_mulaw',
      '-ar', String(OUTPUT_AUDIO_RATE),
      '-ac', '1',
      '-muxdelay', '0',
      '-muxpreload', '0',
      '-f', 'rtsp',
      '-rtsp_transport', 'tcp',
      RTSP_URL
    ];
  }

  return [
    ...audioInput,
    '-re',
    '-f', 'lavfi',
    '-i', 'color=c=black:s=640x360:r=10',
    '-map', '1:v:0',
    '-map', '0:a:0',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-x264-params', 'bframes=0:scenecut=0',
    '-pix_fmt', 'yuv420p',
    '-g', '10',
    '-af', SPEECH_FILTER,
    '-c:a', 'pcm_mulaw',
    '-ar', String(OUTPUT_AUDIO_RATE),
    '-ac', '1',
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-f', 'rtsp',
    '-rtsp_transport', 'tcp',
    RTSP_URL
  ];
}

function buildIdleFfmpegArgs() {
  if (STREAM_MODE === 'audio-only') {
    return [
      '-hide_banner',
      '-loglevel', 'warning',
      '-re',
      '-f', 'lavfi',
      '-i', `anullsrc=channel_layout=mono:sample_rate=${SAMPLE_RATE}`,
      '-c:a', 'pcm_mulaw',
      '-ar', String(OUTPUT_AUDIO_RATE),
      '-ac', '1',
      '-muxdelay', '0',
      '-muxpreload', '0',
      '-f', 'rtsp',
      '-rtsp_transport', 'tcp',
      RTSP_URL
    ];
  }

  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-re',
    '-f', 'lavfi',
    '-i', 'color=c=black:s=640x360:r=10',
    '-re',
    '-f', 'lavfi',
    '-i', `anullsrc=channel_layout=mono:sample_rate=${SAMPLE_RATE}`,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-x264-params', 'bframes=0:scenecut=0',
    '-pix_fmt', 'yuv420p',
    '-g', '10',
    '-c:a', 'pcm_mulaw',
    '-ar', String(OUTPUT_AUDIO_RATE),
    '-ac', '1',
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-f', 'rtsp',
    '-rtsp_transport', 'tcp',
    RTSP_URL
  ];
}

function startFfmpeg(mode = 'live') {
  if (ffmpeg) return ffmpeg;

  bytesReceived = 0;
  startedAt = Date.now();

  const args = mode === 'idle' ? buildIdleFfmpegArgs() : buildLiveFfmpegArgs();
  ffmpegMode = mode;
  console.log(`Starting ${mode} ffmpeg -> ${RTSP_URL}`);
  ffmpeg = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] });

  ffmpeg.on('exit', (code, signal) => {
    console.log(`${mode} ffmpeg stopped code=${code} signal=${signal}`);
    ffmpeg = null;
    ffmpegMode = null;
    if (mode === 'live' && !activeClient && IDLE_STREAM) {
      lastAudioPeakDb = null;
      lastAudioRmsDb = null;
      startFfmpeg('idle');
    }
  });

  if (ffmpeg.stdin) {
    ffmpeg.stdin.on('error', (err) => {
      if (err.code !== 'EPIPE') {
        console.error('ffmpeg stdin error:', err.message);
      }
    });
  }

  return ffmpeg;
}

function stopFfmpeg() {
  if (!ffmpeg) return;

  ffmpeg.stdin?.end();
  ffmpeg.kill('SIGTERM');
  ffmpeg = null;
  ffmpegMode = null;
  if (!activeClient) {
    lastAudioPeakDb = null;
    lastAudioRmsDb = null;
  }
}

function dbFromLinear(value) {
  if (value <= 0) return -Infinity;
  return Math.round(20 * Math.log10(value) * 10) / 10;
}

function updateAudioLevel(buffer) {
  let peak = 0;
  let sumSquares = 0;
  const sampleCount = Math.floor(buffer.length / 2);

  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    const sample = buffer.readInt16LE(offset) / 32768;
    const abs = Math.abs(sample);
    peak = Math.max(peak, abs);
    sumSquares += sample * sample;
  }

  const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
  lastAudioPeakDb = dbFromLinear(peak);
  lastAudioRmsDb = dbFromLinear(rms);
}

function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/mic' });

  wss.on('connection', (ws, req) => {
    if (activeClient) {
      ws.close(1013, 'Another microphone is already connected');
      return;
    }

    activeClient = ws;
    const remote = req.socket.remoteAddress;
    console.log(`iPhone microphone connected from ${remote}`);
    stopFfmpeg();
    let process = null;
    setTimeout(() => {
      if (activeClient === ws) {
        process = startFfmpeg('live');
      }
    }, 500);

    ws.on('message', (message, isBinary) => {
      if (!isBinary || !ffmpeg || !process || process.killed) return;
      bytesReceived += message.length;
      updateAudioLevel(message);
      ffmpeg.stdin.write(message);
    });

    ws.on('close', () => {
      console.log('iPhone microphone disconnected');
      activeClient = null;
      stopFfmpeg();
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
    });
  });
}

if (!fs.existsSync(CERT_PATH) || !fs.existsSync(KEY_PATH)) {
  console.error('Missing HTTPS certificate.');
  console.error('Run: npm run cert');
  process.exit(1);
}

const server = https.createServer({
  cert: fs.readFileSync(CERT_PATH),
  key: fs.readFileSync(KEY_PATH)
}, serveStatic);

attachWebSocket(server);

server.listen(PORT, '0.0.0.0', () => {
  if (IDLE_STREAM) startFfmpeg('idle');
  console.log(`iPhone mic page listening on https://0.0.0.0:${PORT}`);
  for (const address of getLanAddresses()) {
    console.log(`Open this on the iPhone: https://${address}:${PORT}`);
  }
  console.log(`NVR RTSP URL: ${RTSP_URL.replace('127.0.0.1', '<PC_LAN_IP>')}`);
});
