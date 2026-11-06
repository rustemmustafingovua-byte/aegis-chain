#!/usr/bin/env bash
# AEGIS keepalive — как lumen-explorer.sh: держит node+explorer+rpc, сам чинит падения,
# сам обновляет URL туннеля. Kill строго по порту 8899, иначе убьёт соседние сервисы.
set -e
PORT=8899
DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$HOME/.local/state/aegis-node.log"
URL_FILE="$HOME/.local/state/aegis-url.txt"
HEALTH="http://localhost:$PORT/health"

mkdir -p "$(dirname "$LOG")"

if ! curl -sf "$HEALTH" >/dev/null 2>&1; then
  echo "[$(date)] aegis node down, restarting..." >> "$LOG"
  pkill -f "aegis.*8899" 2>/dev/null || true
  cd "$DIR" && nohup npx tsx cli/aegis.ts serve --port=$PORT >> "$LOG" 2>&1 &
  sleep 3
fi

# туннель via tunnel-ensure.sh (если есть): pinggy > localhost.run > bore
if [ -x "$HOME/.config/opencode/scripts/tunnel-ensure.sh" ]; then
  bash "$HOME/.config/opencode/scripts/tunnel-ensure.sh" $PORT "$URL_FILE" "/health" "$LOG" >> "$LOG" 2>&1 || true
fi
echo "[$(date)] aegis ok height=$(curl -s $HEALTH | head -c 200)" >> "$LOG"
