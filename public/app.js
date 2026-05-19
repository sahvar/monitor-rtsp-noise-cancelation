const deviceSelect = document.querySelector('#video-device');
const switchButton = document.querySelector('#switch-device');
const denoiseButton = document.querySelector('#toggle-denoise');
const refreshButton = document.querySelector('#refresh');
const statusBox = document.querySelector('#status');
const serverStatus = document.querySelector('#server-status');
const rtspUrl = document.querySelector('#rtsp-url');
const deviceList = document.querySelector('#device-list');
let aiDenoiseEnabled = false;

function setStatus(message) {
  statusBox.textContent = message;
}

function localRtspUrl(status) {
  const host = location.hostname || '127.0.0.1';
  return status.rtspUrl.replace('127.0.0.1', host);
}

function updateDenoiseButton(enabled) {
  aiDenoiseEnabled = Boolean(enabled);
  denoiseButton.textContent = aiDenoiseEnabled ? 'Disable Denoise' : 'Enable Denoise';
  denoiseButton.dataset.enabled = String(aiDenoiseEnabled);
}

function renderDevices(devices, currentVideoDevice) {
  const selectedDevice = deviceSelect.value || currentVideoDevice;
  deviceSelect.replaceChildren();

  for (const device of devices) {
    const suffix = device.supported ? '' : ` (${device.error || 'unsupported'})`;
    const option = new Option(`${device.name} - ${device.path}${suffix}`, device.path);
    option.disabled = !device.supported;
    deviceSelect.append(option);
  }

  const usableDevices = devices.filter((device) => device.supported);
  deviceSelect.value = usableDevices.some((device) => device.path === selectedDevice)
    ? selectedDevice
    : usableDevices[0]?.path || '';
  switchButton.disabled = usableDevices.length === 0;

  deviceList.textContent = devices.length
    ? devices.map((device) => {
      const state = device.supported ? 'usable' : `not usable: ${device.error || 'unsupported'}`;
      const formats = device.formats?.length ? `\n  ${device.formats.join('\n  ')}` : '';
      return `${device.path}: ${device.name} (${state})${formats}`;
    }).join('\n')
    : 'No /dev/video devices found.';
}

async function loadDevices() {
  const response = await fetch('/devices', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('Could not load webcams from the server.');
  }

  const data = await response.json();
  renderDevices(data.devices, data.currentVideoDevice);
}

async function refreshServerStatus() {
  try {
    const response = await fetch('/status', { cache: 'no-store' });
    const status = await response.json();
    updateDenoiseButton(status.aiDenoise);
    rtspUrl.textContent = localRtspUrl(status);
    serverStatus.textContent = [
      `source: ${status.videoDevice}`,
      `ffmpeg: ${status.ffmpegRunning ? 'running' : 'stopped'}`,
      `mode: ${status.ffmpegMode || 'none'}`,
      `transport: ${status.rtspTransport}`,
      `audio: ${status.audioSource}${status.audioDevice ? ` (${status.audioDevice})` : ''}`,
      `codec: ${status.audioCodec || 'unknown'} ${status.outputAudioRate || ''} Hz`.trim(),
      `ai denoise: ${status.aiDenoise ? 'on' : 'off'}`
    ].join('\n');
  } catch {
    serverStatus.textContent = 'offline';
    rtspUrl.textContent = 'unavailable';
  }
}

async function refreshAll() {
  try {
    await loadDevices();
    await refreshServerStatus();
    setStatus('Ready');
  } catch (error) {
    setStatus(error.message);
  }
}

async function switchDevice() {
  const videoDevice = deviceSelect.value;
  if (!videoDevice) {
    setStatus('Choose a webcam first.');
    return;
  }

  switchButton.disabled = true;
  setStatus(`Switching to ${videoDevice}...`);

  try {
    const response = await fetch('/select-device', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ videoDevice })
    });
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || 'Could not switch webcam.');
    }

    setStatus(`Using ${result.deviceName} (${result.currentVideoDevice}).`);
    setTimeout(refreshAll, 800);
  } catch (error) {
    setStatus(error.message);
  } finally {
    switchButton.disabled = false;
  }
}

async function toggleDenoise() {
  const enabled = !aiDenoiseEnabled;
  denoiseButton.disabled = true;
  setStatus(`${enabled ? 'Enabling' : 'Disabling'} AI denoise...`);

  try {
    const response = await fetch('/denoise', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || 'Could not toggle AI denoise.');
    }

    updateDenoiseButton(result.aiDenoise);
    setStatus(`AI denoise ${result.aiDenoise ? 'enabled' : 'disabled'}${result.appliedLive ? '' : ' for the next stream'}.`);
    await refreshServerStatus();
  } catch (error) {
    setStatus(error.message);
  } finally {
    denoiseButton.disabled = false;
  }
}

switchButton.addEventListener('click', switchDevice);
denoiseButton.addEventListener('click', toggleDenoise);
refreshButton.addEventListener('click', refreshAll);

setInterval(refreshServerStatus, 2000);
refreshAll();
