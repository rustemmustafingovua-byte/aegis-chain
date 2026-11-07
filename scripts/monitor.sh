#!/usr/bin/env bash
# AEGIS Monitor v1.1 — health + metrics + alerts (no daemon, cron/launchd friendly)
set -euo pipefail
PORT="${PORT:-8899}"
curl -fsS "http://127.0.0.1:${PORT}/health" | python3 -c "import sys,json; j=json.load(sys.stdin); print(f\"health ok height={j['height']} version={j['version']}\")"
curl -fsS "http://127.0.0.1:${PORT}/metrics" | head -20
