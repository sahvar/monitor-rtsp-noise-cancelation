# PC Webcam to RTSP

This project publishes a webcam connected directly to this PC as an RTSP stream that an NVR can pull.

Default flow:

```text
PC USB webcam -> ffmpeg -> MediaMTX RTSP -> NVR
```

The default stream uses the PC webcam video and the FaceCam USB microphone on `plughw:2,0`. It does not use an iPhone, Samsung/DroidCam microphone, or any browser microphone unless you explicitly switch back to browser microphone mode.

## Requirements

- A webcam connected to this PC, usually `/dev/video0`
- Node.js 18+
- `ffmpeg`
- Docker, for the included MediaMTX RTSP server

Install `ffmpeg` and Docker on Ubuntu if needed:

```bash
sudo apt update
sudo apt install -y ffmpeg docker.io docker-compose-plugin
```

## Find the Webcam

List video devices:

```bash
v4l2-ctl --list-devices
```

If `v4l2-ctl` is missing:

```bash
sudo apt install -y v4l-utils
```

The app defaults to:

```text
/dev/video0
```

## Setup

Install Node dependencies:

```bash
npm install
```

Start the RTSP server:

```bash
docker compose up -d
```

Start publishing the PC webcam:

```bash
npm start
```

The status page is available on this PC:

```text
http://127.0.0.1:8443
```

## NVR URL

Add this stream to the NVR:

```text
rtsp://PC_LAN_IP:554/pc-webcam
```

Example:

```text
rtsp://192.168.1.50:554/pc-webcam
```

## Testing With VLC

Before adding it to the NVR, test from this PC:

```bash
ffplay rtsp://127.0.0.1:554/pc-webcam
```

For the lowest-latency local test:

```bash
ffplay -fflags nobuffer -flags low_delay -framedrop -strict experimental -rtsp_transport udp rtsp://127.0.0.1:554/pc-webcam
```

Or open the RTSP URL in VLC.

## Configuration

You can override these environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8443` | HTTP status page port |
| `STREAM_SOURCE` | `pc-webcam` | Use `pc-webcam` for the directly connected webcam, or `browser-mic` for the old browser microphone bridge |
| `RTSP_URL` | `rtsp://127.0.0.1:554/pc-webcam` | RTSP publish URL used by `ffmpeg` |
| `VIDEO_DEVICE` | `/dev/video0` | Linux video device for the connected webcam |
| `VIDEO_SIZE` | `640x480` | Capture resolution |
| `RTSP_TRANSPORT` | `udp` | RTSP publishing transport; `udp` is lowest latency, `tcp` is more firewall-friendly |
| `VIDEO_FRAMERATE` | `30` | Capture frame rate |
| `VIDEO_FORMAT` | empty | Optional v4l2 input format, such as `mjpeg` |
| `AUDIO_SOURCE` | `alsa` | Use `alsa` to capture a chosen ALSA audio device, or `silent` for no microphone audio |
| `AUDIO_DEVICE` | `plughw:2,0` | ALSA audio device used when `AUDIO_SOURCE=alsa` |
| `AI_DENOISE` | `true` | Start with the stronger AI denoise branch enabled; set to `false` to start raw |
| `RNNOISE_MIX` | `0.93` | RNNoise strength in the denoised branch; higher removes more noise but can blur words |
| `AUDIO_CODEC` | `aac` | Use `aac` for clearer speech, or `mulaw` for G.711/NVR compatibility |
| `OUTPUT_AUDIO_RATE` | `24000` for AAC, `8000` for mulaw | RTSP audio sample rate |
| `AUDIO_BITRATE` | `96k` | AAC bitrate |

AI denoise can also be toggled live from the status page without restarting the RTSP stream.

Use a different webcam:

```bash
VIDEO_DEVICE=/dev/video2 npm start
```

Use a higher resolution:

```bash
VIDEO_SIZE=1280x720 VIDEO_FRAMERATE=30 VIDEO_FORMAT=mjpeg npm start
```

Enable a specific PC audio device only if you really want audio from that device:

```bash
AUDIO_SOURCE=alsa AUDIO_DEVICE=plughw:1,0 npm start
```

## Browser Microphone Fallback

The old browser microphone bridge is still available, but it is no longer the default:

```bash
npm run cert
STREAM_SOURCE=browser-mic RTSP_URL=rtsp://127.0.0.1:554/pc-webcam npm start
```

In that mode, open the HTTPS page printed by the server and start the microphone stream manually.

## Notes

- Make sure the PC firewall allows TCP port `554` for the NVR.
- If ffmpeg says the video device is busy, close any app that is using the webcam.
- If capture fails at a high resolution, try `VIDEO_SIZE=640x480` first, then increase it after the stream works.
