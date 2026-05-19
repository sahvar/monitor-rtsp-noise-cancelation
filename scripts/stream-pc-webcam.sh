#!/usr/bin/env bash
set -euo pipefail

VIDEO_DEVICE="${VIDEO_DEVICE:-/dev/video0}"
VIDEO_SIZE="${VIDEO_SIZE:-640x480}"
VIDEO_FRAMERATE="${VIDEO_FRAMERATE:-15}"
VIDEO_FORMAT="${VIDEO_FORMAT:-}"
RTSP_URL="${RTSP_URL:-rtsp://127.0.0.1:554/pc-webcam}"
SAMPLE_RATE="${SAMPLE_RATE:-48000}"
OUTPUT_AUDIO_RATE="${OUTPUT_AUDIO_RATE:-8000}"

echo "Publishing PC webcam ${VIDEO_DEVICE} to ${RTSP_URL}"

video_args=(
  -f v4l2
  -framerate "$VIDEO_FRAMERATE"
  -video_size "$VIDEO_SIZE"
)

if [[ -n "$VIDEO_FORMAT" ]]; then
  video_args+=(-input_format "$VIDEO_FORMAT")
fi

exec ffmpeg \
  -hide_banner \
  -loglevel warning \
  "${video_args[@]}" \
  -i "$VIDEO_DEVICE" \
  -f lavfi \
  -i "anullsrc=channel_layout=mono:sample_rate=${SAMPLE_RATE}" \
  -map 0:v:0 \
  -map 1:a:0 \
  -c:v libx264 \
  -preset ultrafast \
  -tune zerolatency \
  -x264-params bframes=0:scenecut=0 \
  -pix_fmt yuv420p \
  -g "$((VIDEO_FRAMERATE * 2))" \
  -c:a pcm_mulaw \
  -ar "$OUTPUT_AUDIO_RATE" \
  -ac 1 \
  -shortest \
  -muxdelay 0 \
  -muxpreload 0 \
  -f rtsp \
  -rtsp_transport tcp \
  "$RTSP_URL"
