const startButton = document.querySelector('#start');
const stopButton = document.querySelector('#stop');
const statusBox = document.querySelector('#status');
const serverStatus = document.querySelector('#server-status');
const audioDeviceSelect = document.querySelector('#audio-device');
const levelBar = document.querySelector('#level-bar');
const micLevel = document.querySelector('#mic-level');

const TARGET_SAMPLE_RATE = 48000;
const BUFFER_SIZE = 1024;
const MAX_WEBSOCKET_BACKLOG = BUFFER_SIZE * 8;

let socket = null;
let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;

function setStatus(message) {
  statusBox.textContent = message;
}

async function loadAudioDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const audioInputs = devices.filter((device) => device.kind === 'audioinput');
  const selectedDeviceId = audioDeviceSelect.value;

  audioDeviceSelect.replaceChildren(new Option('Default microphone', ''));

  for (const [index, device] of audioInputs.entries()) {
    const label = device.label || `Microphone ${index + 1}`;
    audioDeviceSelect.append(new Option(label, device.deviceId));
  }

  audioDeviceSelect.value = selectedDeviceId;
}

function floatToPcm16(samples) {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);

  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return buffer;
}

function downmixToMono(inputBuffer) {
  if (inputBuffer.numberOfChannels === 1) {
    return inputBuffer.getChannelData(0);
  }

  const left = inputBuffer.getChannelData(0);
  const right = inputBuffer.getChannelData(1);
  const mono = new Float32Array(left.length);

  for (let i = 0; i < left.length; i += 1) {
    mono[i] = (left[i] + right[i]) / 2;
  }

  return mono;
}

function updateLocalLevel(samples) {
  let peak = 0;
  let sumSquares = 0;

  for (const sample of samples) {
    const abs = Math.abs(sample);
    peak = Math.max(peak, abs);
    sumSquares += sample * sample;
  }

  const rms = samples.length ? Math.sqrt(sumSquares / samples.length) : 0;
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  const percent = Math.min(100, Math.max(0, (peakDb + 60) * (100 / 60)));

  levelBar.style.width = `${percent}%`;
  micLevel.textContent = Number.isFinite(rmsDb) ? `${rmsDb.toFixed(1)} dB RMS` : 'no signal';
}

function withTimeout(promise, message, timeoutMs = 15000) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function requestMicrophone() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone access requires HTTPS and a browser that supports getUserMedia.');
  }

  const selectedDeviceId = audioDeviceSelect.value;
  const audio = {
    echoCancellation: { ideal: true },
    noiseSuppression: false,
    autoGainControl: false,
    suppressLocalAudioPlayback: true,
    ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {})
  };

  return withTimeout(
    navigator.mediaDevices.getUserMedia({ audio, video: false }),
    'Microphone permission timed out. In Safari, allow microphone access for this website and try again.'
  );
}

async function start() {
  startButton.disabled = true;
  audioDeviceSelect.disabled = true;
  setStatus('Requesting microphone permission...');

  try {
    mediaStream = await requestMicrophone();

    await loadAudioDevices();
    socket = new WebSocket(`wss://${location.host}/mic`);
    socket.binaryType = 'arraybuffer';

    socket.addEventListener('open', async () => {
      audioContext = new AudioContext({
        sampleRate: TARGET_SAMPLE_RATE,
        latencyHint: 'interactive'
      });
      sourceNode = audioContext.createMediaStreamSource(mediaStream);
      processorNode = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);

      processorNode.onaudioprocess = (event) => {
        for (let channel = 0; channel < event.outputBuffer.numberOfChannels; channel += 1) {
          event.outputBuffer.getChannelData(channel).fill(0);
        }
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > MAX_WEBSOCKET_BACKLOG) return;
        const monoSamples = downmixToMono(event.inputBuffer);
        updateLocalLevel(monoSamples);
        socket.send(floatToPcm16(monoSamples));
      };

      sourceNode.connect(processorNode);
      processorNode.connect(audioContext.destination);

      stopButton.disabled = false;
      setStatus('Streaming microphone audio to the PC. Keep this page open.');
    });

    socket.addEventListener('close', (event) => {
      stop();
      if (event.code === 1013) {
        setStatus('Another phone is already connected.');
      } else {
        setStatus('Stream stopped.');
      }
    });

    socket.addEventListener('error', () => {
      setStatus('WebSocket connection failed. Check that the PC server is still running.');
    });
  } catch (error) {
    startButton.disabled = false;
    audioDeviceSelect.disabled = false;
    setStatus(`Could not start microphone: ${error.message}`);
  }
}

function stop() {
  if (processorNode) {
    processorNode.disconnect();
    processorNode.onaudioprocess = null;
    processorNode = null;
  }

  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      track.stop();
    }
    mediaStream = null;
  }

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.close();
  }
  socket = null;

  startButton.disabled = false;
  stopButton.disabled = true;
  audioDeviceSelect.disabled = false;
  levelBar.style.width = '0%';
  micLevel.textContent = 'no signal';
}

async function refreshServerStatus() {
  try {
    const response = await fetch('/status', { cache: 'no-store' });
    const status = await response.json();
    const level = Number.isFinite(status.audioRmsDb) ? `, server audio ${status.audioRmsDb} dB RMS` : '';
    serverStatus.textContent = `${status.connected ? 'phone connected' : 'waiting'}, ${status.ffmpegRunning ? 'ffmpeg running' : 'ffmpeg stopped'}${level}, ${status.rtspUrl}`;
  } catch {
    serverStatus.textContent = 'offline';
  }
}

startButton.addEventListener('click', start);
stopButton.addEventListener('click', () => {
  stop();
  setStatus('Stream stopped.');
});
navigator.mediaDevices?.addEventListener?.('devicechange', loadAudioDevices);

setInterval(refreshServerStatus, 2000);
refreshServerStatus();
loadAudioDevices();
