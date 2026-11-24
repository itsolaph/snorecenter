#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PORT="${PORT:-8080}"
export HOST="${HOST:-0.0.0.0}"

cd "${APP_DIR}"
if [ ! -f samples/last-night-highlight.wav ]; then
  node scripts/generate-samples.mjs
fi

exec node src/server.mjs
