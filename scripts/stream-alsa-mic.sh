#!/usr/bin/env bash
set -euo pipefail

AUDIO_DEVICE="${AUDIO_DEVICE:-plughw:0,0}"
RTSP_URL="${RTSP_URL:-rtsp://127.0.0.1:554/iphone-mic}"
SAMPLE_RATE="${SAMPLE_RATE:-48000}"
AUDIO_FILTER="${AUDIO_FILTER:-highpass=f=120,lowpass=f=8000,afftdn=nf=-25}"

echo "Publishing ALSA microphone ${AUDIO_DEVICE} to ${RTSP_URL}"

exec ffmpeg \
  -hide_banner \
  -loglevel warning \
  -f alsa \
  -ac 1 \
  -ar "$SAMPLE_RATE" \
  -i "$AUDIO_DEVICE" \
  -re \
  -f lavfi \
  -i 'color=c=black:s=640x360:r=10' \
  -map 1:v:0 \
  -map 0:a:0 \
  -c:v libx264 \
  -preset veryfast \
  -tune zerolatency \
  -pix_fmt yuv420p \
  -g 20 \
  -af "$AUDIO_FILTER" \
  -c:a aac \
  -b:a 96k \
  -f rtsp \
  -rtsp_transport tcp \
  "$RTSP_URL"
