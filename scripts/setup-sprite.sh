#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:-/home/sprite/snorecenter}"
PORT="${PORT:-8080}"

echo "[snorecenter] Provisioning Fly.io Sprite in ${APP_DIR}..."

if command -v apt-get >/dev/null 2>&1; then
  if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v sox >/dev/null 2>&1; then
    echo "[snorecenter] Installing ffmpeg and sox..."
    sudo apt-get update -qq
    sudo apt-get install -y -qq ffmpeg sox
  fi
fi

cd "${APP_DIR}"
node --version
node scripts/generate-samples.mjs

if command -v sprite-env >/dev/null 2>&1; then
  echo "[snorecenter] Registering wake-on-HTTP Sprite service on port ${PORT}..."
  sprite-env services delete snorecenter >/dev/null 2>&1 || true
  sprite-env services create snorecenter \
    --cmd /usr/bin/env \
    --args "PORT=${PORT},HOST=0.0.0.0,node,${APP_DIR}/src/server.mjs" \
    --dir "${APP_DIR}" \
    --http-port "${PORT}"
  echo "[snorecenter] Taking baseline CoW checkpoint..."
  sprite-env checkpoint create --comment "snorecenter-provisioned" || true
else
  echo "[snorecenter] sprite-env not found; run 'npm start' directly for local development."
fi

echo "[snorecenter] Done. Verify with: curl -s http://127.0.0.1:${PORT}/healthz"
