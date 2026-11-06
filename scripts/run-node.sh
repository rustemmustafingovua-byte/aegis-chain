#!/usr/bin/env bash
# Запуск AEGIS узла (dev)
set -e
PORT=${1:-8899}
cd "$(dirname "$0")/.."
exec npx tsx cli/aegis.ts serve --port=$PORT
