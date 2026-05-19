import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8443);
const SAMPLE_RATE = Number(process.env.SAMPLE_RATE || 48000);
const CHANNELS = Number(process.env.CHANNELS || 1);
const STREAM_SOURCE = process.env.STREAM_SOURCE || 'pc-webcam';
const RTSP_URL = process.env.RTSP_URL || 'rtsp://127.0.0.1:554/pc-webcam';
const RTSP_TRANSPORT = process.env.RTSP_TRANSPORT || 'udp';
const STREAM_MODE = process.env.STREAM_MODE || 'black-video';
const DEFAULT_VIDEO_DEVICE = process.env.VIDEO_DEVICE || '/dev/video0';
const VIDEO_SIZE = process.env.VIDEO_SIZE || '640x480';
const VIDEO_FRAMERATE = Number(process.env.VIDEO_FRAMERATE || 30);
const VIDEO_FORMAT = process.env.VIDEO_FORMAT || '';
const AUDIO_SOURCE = process.env.AUDIO_SOURCE || 'alsa';
const AUDIO_DEVICE = process.env.AUDIO_DEVICE || 'plughw:2,0';
const AUDIO_CODEC = process.env.AUDIO_CODEC || 'aac';
const OUTPUT_AUDIO_RATE = Number(process.env.OUTPUT_AUDIO_RATE || (AUDIO_CODEC === 'aac' ? 24000 : 8000));
const RNNOISE_MODEL_PATH = process.env.RNNOISE_MODEL_PATH || path.join(__dirname, 'models', 'std.rnnn');
const RNNOISE_MIX = process.env.RNNOISE_MIX || '0.65';
const AI_DENOISE = process.env.AI_DENOISE !== 'false';
const MIC_GAIN = process.env.MIC_GAIN || '0.45';
const GATE_THRESHOLD = process.env.GATE_THRESHOLD || '0.03';
const RNNOISE_FILTER_NAME = 'rnnoise';
const RAW_AUDIO_VOLUME_NAME = 'rawaudio';
const DENOISED_AUDIO_VOLUME_NAME = 'denoisedaudio';
const DEFAULT_SPEECH_FILTER = [
  'highpass=f=100',
  'lowpass=f=7200',
  'afftdn=nr=5:nf=-58:tn=1:ad=0.25:rf=-36:gs=3',
  `arnndn@${RNNOISE_FILTER_NAME}=m='${RNNOISE_MODEL_PATH}':mix=${RNNOISE_MIX}`,
  'equalizer=f=220:t=q:w=1.0:g=-2',
  'equalizer=f=1300:t=q:w=1.0:g=1.5',
  'equalizer=f=3000:t=q:w=1.0:g=2.5',
  'speechnorm=e=1.8:c=1.2:r=0.0007:f=0.0007:p=0.92:m=0.05',
  'alimiter=limit=0.94'
].join(',');
const SPEECH_FILTER = process.env.SPEECH_FILTER || DEFAULT_SPEECH_FILTER;
const IDLE_STREAM = process.env.IDLE_STREAM !== 'false';
const CERT_PATH = process.env.CERT_PATH || path.join(__dirname, 'certs', 'server.crt');
const KEY_PATH = process.env.KEY_PATH || path.join(__dirname, 'certs', 'server.key');
const STATUS_PROTOCOL = STREAM_SOURCE === 'browser-mic' ? 'https' : 'http';

let ffmpeg = null;
let ffmpegMode = null;
let activeClient = null;
let bytesReceived = 0;
let startedAt = null;
let lastAudioPeakDb = null;
let lastAudioRmsDb = null;
let currentVideoDevice = DEFAULT_VIDEO_DEVICE;
let aiDenoiseEnabled = AI_DENOISE;

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

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function listVideoDevices() {
  try {
    const output = execFileSync('v4l2-ctl', ['--list-devices'], { encoding: 'utf8' });
    const devices = [];
    let currentName = null;

    for (const line of output.split('\n')) {
      if (!line.trim()) continue;

      if (!line.startsWith('\t')) {
        currentName = line.replace(/\s+\(.+\):$/, '').trim();
        continue;
      }

      const devicePath = line.trim();
      if (devicePath.startsWith('/dev/video')) {
        const formatInfo = getVideoFormatInfo(devicePath);
        devices.push({
          path: devicePath,
          name: currentName || devicePath,
          supported: formatInfo.supported,
          formats: formatInfo.formats,
          error: formatInfo.error
        });
      }
    }

    return devices;
  } catch (err) {
    console.error('Could not list video devices:', err.message);
    return [];
  }
}

function getVideoFormatInfo(devicePath) {
  const result = spawnSync('ffmpeg', [
    '-hide_banner',
    '-f', 'v4l2',
    '-list_formats', 'all',
    '-i', devicePath
  ], { encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const formats = output
    .split('\n')
    .filter((line) => line.includes('Raw') || line.includes('Compressed') || line.includes('Unsupported'))
    .map((line) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').trim());
  const supported = formats.some((line) => !line.includes('Unsupported'));
  const unsupportedOnly = formats.length > 0 && !supported;
  const error = unsupportedOnly
    ? 'Unsupported camera format'
    : supported
      ? null
      : output.split('\n').find((line) => line.includes('Error opening input')) || 'Cannot inspect device';

  return { supported, formats, error };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 8) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const publicDir = path.join(__dirname, 'public');
  const requestedPath = new URL(req.url, `${STATUS_PROTOCOL}://${req.headers.host}`).pathname;

  if (requestedPath === '/status') {
    const uptimeSeconds = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
    sendJson(res, 200, {
      connected: Boolean(activeClient),
      ffmpegRunning: Boolean(ffmpeg),
      bytesReceived,
      uptimeSeconds,
      rtspUrl: RTSP_URL,
      rtspTransport: RTSP_TRANSPORT,
      streamSource: STREAM_SOURCE,
      streamMode: STREAM_MODE,
      ffmpegMode,
      videoDevice: currentVideoDevice,
      audioSource: AUDIO_SOURCE,
      audioDevice: AUDIO_DEVICE,
      audioCodec: AUDIO_CODEC,
      outputAudioRate: OUTPUT_AUDIO_RATE,
      aiDenoise: aiDenoiseEnabled,
      audioPeakDb: lastAudioPeakDb,
      audioRmsDb: lastAudioRmsDb
    });
    return;
  }

  if (requestedPath === '/denoise' && req.method === 'POST') {
    readRequestBody(req)
      .then((body) => {
        const payload = JSON.parse(body || '{}');
        const enabled = Boolean(payload.enabled);
        const result = setAiDenoise(enabled);

        sendJson(res, result.ok ? 200 : 500, result);
      })
      .catch((err) => {
        sendJson(res, 400, { ok: false, error: err.message });
      });
    return;
  }

  if (requestedPath === '/devices') {
    sendJson(res, 200, {
      currentVideoDevice,
      devices: listVideoDevices()
    });
    return;
  }

  if (requestedPath === '/select-device' && req.method === 'POST') {
    readRequestBody(req)
      .then((body) => {
        const payload = JSON.parse(body || '{}');
        const requestedDevice = String(payload.videoDevice || '');
        const devices = listVideoDevices();
        const selected = devices.find((device) => device.path === requestedDevice);

        if (!selected) {
          sendJson(res, 400, {
            ok: false,
            error: `Unknown video device: ${requestedDevice}`
          });
          return;
        }

        if (!selected.supported) {
          sendJson(res, 400, {
            ok: false,
            error: `${selected.path} cannot be used by ffmpeg: ${selected.error || 'unsupported'}`
          });
          return;
        }

        currentVideoDevice = selected.path;
        stopFfmpeg();
        if (STREAM_SOURCE === 'pc-webcam') {
          setTimeout(() => startFfmpeg('pc-webcam'), 250);
        }

        sendJson(res, 200, {
          ok: true,
          currentVideoDevice,
          deviceName: selected.name
        });
      })
      .catch((err) => {
        sendJson(res, 400, { ok: false, error: err.message });
      });
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

function buildPcWebcamFfmpegArgs() {
  const videoInput = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-probesize', '32',
    '-analyzeduration', '0',
    '-thread_queue_size', '512',
    '-use_wallclock_as_timestamps', '1',
    '-f', 'v4l2',
    '-framerate', String(VIDEO_FRAMERATE),
    '-video_size', VIDEO_SIZE,
    ...(VIDEO_FORMAT ? ['-input_format', VIDEO_FORMAT] : []),
    '-i', currentVideoDevice
  ];

  const audioInput = AUDIO_SOURCE === 'alsa'
    ? [
      '-thread_queue_size', '512',
      '-f', 'alsa',
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-i', AUDIO_DEVICE
    ]
    : ['-f', 'lavfi', '-i', `anullsrc=channel_layout=mono:sample_rate=${SAMPLE_RATE}`];
  const keyframeInterval = Math.max(1, VIDEO_FRAMERATE);
  const rawVolume = aiDenoiseEnabled ? '0' : '1';
  const denoisedVolume = aiDenoiseEnabled ? '1' : '0';
  const webcamAudioFilter = [
    '[1:a]asplit=2[raw][denoisein]',
    `[raw]volume@${RAW_AUDIO_VOLUME_NAME}=${rawVolume}[rawout]`,
    `[denoisein]${SPEECH_FILTER},volume@${DENOISED_AUDIO_VOLUME_NAME}=${denoisedVolume}[denoisedout]`,
    '[rawout][denoisedout]amix=inputs=2:normalize=0:duration=first[aout]'
  ].join(';');
  const outputAudioArgs = AUDIO_CODEC === 'mulaw'
    ? ['-c:a', 'pcm_mulaw', '-ar', String(OUTPUT_AUDIO_RATE), '-ac', '1']
    : ['-c:a', 'aac', '-b:a', process.env.AUDIO_BITRATE || '96k', '-ar', String(OUTPUT_AUDIO_RATE), '-ac', '1'];

  return [
    ...videoInput,
    ...audioInput,
    '-filter_complex', webcamAudioFilter,
    '-map', '0:v:0',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-profile:v', 'baseline',
    '-level:v', '3.1',
    '-bf', '0',
    '-x264-params', `bframes=0:force-cfr=1:keyint=${keyframeInterval}:min-keyint=${keyframeInterval}:scenecut=0:sliced-threads=1:slice-max-size=800:sync-lookahead=0:rc-lookahead=0`,
    '-pix_fmt', 'yuv420p',
    '-g', String(keyframeInterval),
    ...outputAudioArgs,
    '-shortest',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-flush_packets', '1',
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-f', 'rtsp',
    '-rtsp_transport', RTSP_TRANSPORT,
    RTSP_URL
  ];
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

  const args = mode === 'pc-webcam'
    ? buildPcWebcamFfmpegArgs()
    : mode === 'idle'
      ? buildIdleFfmpegArgs()
      : buildLiveFfmpegArgs();
  const usesStdin = mode === 'live' || mode === 'pc-webcam';
  ffmpegMode = mode;
  console.log(`Starting ${mode} ffmpeg -> ${RTSP_URL}`);
  ffmpeg = spawn('ffmpeg', args, { stdio: [usesStdin ? 'pipe' : 'ignore', 'inherit', 'inherit'] });

  ffmpeg.on('exit', (code, signal) => {
    console.log(`${mode} ffmpeg stopped code=${code} signal=${signal}`);
    ffmpeg = null;
    ffmpegMode = null;
    if (STREAM_SOURCE === 'browser-mic' && mode === 'live') {
      if (activeClient) {
        // Recover from transient RTSP/network failures while a mic client is connected.
        setTimeout(() => {
          if (activeClient && !ffmpeg) startFfmpeg('live');
        }, 400);
      } else if (IDLE_STREAM) {
        lastAudioPeakDb = null;
        lastAudioRmsDb = null;
        setTimeout(() => {
          if (!activeClient && !ffmpeg) startFfmpeg('idle');
        }, 400);
      }
    } else if (mode === 'idle' && !activeClient && IDLE_STREAM) {
      // Keep an idle carrier available for NVR/VLC probes.
      setTimeout(() => {
        if (!activeClient && !ffmpeg) startFfmpeg('idle');
      }, 400);
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

function setAiDenoise(enabled) {
  aiDenoiseEnabled = enabled;

  if (!ffmpeg || !ffmpeg.stdin || ffmpeg.stdin.destroyed || ffmpegMode !== 'pc-webcam') {
    return {
      ok: true,
      aiDenoise: aiDenoiseEnabled,
      appliedLive: false
    };
  }

  const rawVolume = enabled ? '0' : '1';
  const denoisedVolume = enabled ? '1' : '0';
  const commands = [
    `cvolume@${RAW_AUDIO_VOLUME_NAME} -1 volume ${rawVolume}\n`,
    `cvolume@${DENOISED_AUDIO_VOLUME_NAME} -1 volume ${denoisedVolume}\n`
  ];
  const written = commands.every((command) => ffmpeg.stdin.write(command));

  return {
    ok: written,
    aiDenoise: aiDenoiseEnabled,
    appliedLive: written
  };
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
  const pingInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 10000);

  wss.on('close', () => clearInterval(pingInterval));

  wss.on('connection', (ws, req) => {
    if (activeClient) {
      ws.close(1013, 'Another microphone is already connected');
      return;
    }

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    activeClient = ws;
    const remote = req.socket.remoteAddress;
    console.log(`Browser microphone connected from ${remote}`);
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
      console.log('Browser microphone disconnected');
      activeClient = null;
      stopFfmpeg();
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
    });
  });
}

if (STREAM_SOURCE === 'browser-mic' && (!fs.existsSync(CERT_PATH) || !fs.existsSync(KEY_PATH))) {
  console.error('Missing HTTPS certificate.');
  console.error('Run: npm run cert');
  process.exit(1);
}

const server = STREAM_SOURCE === 'browser-mic'
  ? https.createServer({
    cert: fs.readFileSync(CERT_PATH),
    key: fs.readFileSync(KEY_PATH)
  }, serveStatic)
  : http.createServer(serveStatic);

if (STREAM_SOURCE === 'browser-mic') {
  attachWebSocket(server);
}

server.listen(PORT, '0.0.0.0', () => {
  if (STREAM_SOURCE === 'pc-webcam') {
    startFfmpeg('pc-webcam');
  } else if (IDLE_STREAM) {
    startFfmpeg('idle');
  }

  console.log(`RTSP bridge status page listening on ${STATUS_PROTOCOL}://0.0.0.0:${PORT}`);
  for (const address of getLanAddresses()) {
    console.log(`Status page: ${STATUS_PROTOCOL}://${address}:${PORT}`);
  }
  console.log(`NVR RTSP URL: ${RTSP_URL.replace('127.0.0.1', '<PC_LAN_IP>')}`);
  if (STREAM_SOURCE === 'pc-webcam') {
    console.log(`Using PC webcam: ${currentVideoDevice} (${VIDEO_SIZE} @ ${VIDEO_FRAMERATE} fps)`);
    console.log(`Audio source: ${AUDIO_SOURCE === 'alsa' ? AUDIO_DEVICE : 'silent'}`);
  }
});
