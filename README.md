# iPhone Mic to RTSP

This project lets an iPhone, PC browser, or DroidCam virtual microphone act as a microphone for an RTSP stream that an NVR can pull.

Flow:

```text
Browser microphone -> HTTPS WebSocket -> this PC -> ffmpeg -> MediaMTX RTSP -> NVR
```

The RTSP stream defaults to black video plus microphone audio for better NVR compatibility.

## Requirements

- iPhone and PC on the same LAN, or a microphone available to the PC browser
- Node.js 18+
- `ffmpeg`
- Docker, for the included MediaMTX RTSP server

Install `ffmpeg` and Docker on Ubuntu if needed:

```bash
sudo apt update
sudo apt install -y ffmpeg docker.io docker-compose-plugin
```

## Setup

Install Node dependencies:

```bash
npm install
```

Create the local HTTPS certificate:

```bash
npm run cert
```

Start the RTSP server:

```bash
docker compose up -d
```

Start the iPhone microphone bridge:

```bash
npm start
```

The app prints one or more iPhone URLs like:

```text
https://192.168.1.50:8443
```

Open that URL on the iPhone, accept the certificate warning, allow microphone permission, choose the microphone if needed, and tap **Start Microphone Stream**.

For PC browser testing, open:

```text
https://127.0.0.1:8443
```

Allow microphone permission, choose the PC microphone or DroidCam virtual microphone from the dropdown, and tap **Start Microphone Stream**.

## NVR URL

Add this stream to the NVR:

```text
rtsp://PC_LAN_IP:554/iphone-mic
```

Example:

```text
rtsp://192.168.1.50:554/iphone-mic
```

## Testing With VLC

Before adding it to the NVR, test from another device or from this PC:

```bash
ffplay rtsp://127.0.0.1:554/iphone-mic
```

Or open the RTSP URL in VLC.

## Configuration

You can override these environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8443` | HTTPS port for the iPhone web page |
| `RTSP_URL` | `rtsp://127.0.0.1:554/iphone-mic` | RTSP publish URL used by `ffmpeg` |
| `STREAM_MODE` | `black-video` | Use `black-video` for NVR compatibility or `audio-only` for audio-only RTSP |
| `SAMPLE_RATE` | `48000` | PCM sample rate sent to `ffmpeg` |
| `CHANNELS` | `1` | Audio channel count |
| `RNNOISE_MODEL_PATH` | `models/std.rnnn` | Neural noise reduction model for FFmpeg `arnndn` |
| `RNNOISE_MIX` | `0.85` | RNNoise strength; lower is more natural, higher removes more noise |
| `AI_DENOISE` | `false` | Enable RNNoise neural denoising; adds latency |
| `SPEECH_FILTER` | built in | Override the full FFmpeg speech cleanup filter |

Audio-only mode:

```bash
STREAM_MODE=audio-only npm start
```

## Notes

- Keep the iPhone screen awake while streaming. iOS may suspend browser audio capture when the page is backgrounded or the phone locks.
- iPhone microphone access requires HTTPS on LAN. That is why this project generates a local self-signed certificate.
- If the NVR cannot connect, make sure the PC firewall allows TCP ports `554` and `8443`.
- Live audio uses low-latency voice-band filtering before publishing G.711 audio to the NVR. RNNoise/`arnndn` can be enabled with `AI_DENOISE=true`, but it adds delay.
