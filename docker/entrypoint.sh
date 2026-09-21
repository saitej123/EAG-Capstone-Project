#!/usr/bin/env bash
set -euo pipefail

cd /app

export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/app/.playwright-browsers}"
MARKER="${PLAYWRIGHT_BROWSERS_PATH}/.chromium-installed"

if [[ ! -f "${MARKER}" ]]; then
  echo "Installing Playwright Chromium to ${PLAYWRIGHT_BROWSERS_PATH}…"
  mkdir -p "${PLAYWRIGHT_BROWSERS_PATH}"
  playwright install chromium
  touch "${MARKER}"
fi

mkdir -p workspace automation_output logs models

exec python run.py
