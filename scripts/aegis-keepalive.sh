#!/usr/bin/env bash
# AEGIS keepalive — как lumen-explorer.sh: держит node+explorer+rpc, сам чинит падения,
# сам обновляет URL туннеля. Kill строго по порту 8899, иначе убьёт соседние сервисы.
set -e
# launchd запускает с минимальным PATH — добавляем homebrew/node явно
export PATH="$HOME/.homebrew/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
PORT=8899
REPO="${AEGIS_REPO:-$HOME/workspace/workspace/aegis-chain}"
DIR="$(cd "$REPO" && pwd)"
LOG="$HOME/.local/state/aegis-node.log"
URL_FILE="$HOME/.local/state/aegis-url.txt"
HEALTH="http://localhost:$PORT/health"
# devnet heartbeat: пустая цепь не растёт, а лёгкому клиенту нужны заголовки и чекпоинты.
# 15 слотов × 4с = ~1 блок/мин; чекпоинт каждые 2 блока (~2 мин).
export AEGIS_EMPTY_BLOCK_SLOTS="${AEGIS_EMPTY_BLOCK_SLOTS:-15}"
export AEGIS_CHECKPOINT_EVERY="${AEGIS_CHECKPOINT_EVERY:-2}"

mkdir -p "$(dirname "$LOG")"

if ! curl -sf "$HEALTH" >/dev/null 2>&1; then
  echo "[$(date)] aegis node down, restarting..." >> "$LOG"
  # kill строго по точной командной строке порта 8899 (не задевая другие узлы)
  pkill -f "cli/aegis.ts serve --port=8899" 2>/dev/null || true
  cd "$DIR" && nohup npx tsx cli/aegis.ts serve --port=$PORT >> "$LOG" 2>&1 &
  sleep 3
fi

# туннель via tunnel-ensure.sh (если есть): pinggy > localhost.run > bore
if [ -x "$HOME/.config/opencode/scripts/tunnel-ensure.sh" ]; then
  bash "$HOME/.config/opencode/scripts/tunnel-ensure.sh" $PORT "$URL_FILE" "/health" "aegis" >> "$LOG" 2>&1 || true
fi
echo "[$(date)] aegis ok height=$(curl -s $HEALTH | head -c 200)" >> "$LOG"
