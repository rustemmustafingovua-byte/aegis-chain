#!/usr/bin/env bash
# AEGIS Sneaker Sync v1.8 — USB-stick mesh transport (DTN sneakernet)
# Usage: bash scripts/sneaker-sync.sh <src-queue.json> <dst-queue.json>
# Copies offline queue file between machines (USB), then нода подхватит через aegis node load.
set -euo pipefail
SRC="${1:-$HOME/.local/state/aegis-mesh-queue.json}"
DST="${2:-/Volumes/USB/aegis-mesh-queue.json}"
cp "$SRC" "$DST" 2>&1
echo "sneaker: $SRC → $DST"
echo "На целевой ноде: нода загрузит через MeshNode.loadQueue(dst) при старте (или вручную)."
