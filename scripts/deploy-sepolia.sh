#!/usr/bin/env bash
# AEGIS Base Sepolia Deploy v0.9 — forge create for AEGIS / AegisAMM / BridgeVault
# Usage: cp .env.example .env && fill PRIVATE_KEY + RPC, then bash scripts/deploy-sepolia.sh
# Network: Base Sepolia (chain 84532) — testnet only, real money requires mainnet audit.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${RPC_URL:=https://sepolia.base.org}"
: "${CHAIN_ID:=84532}"
: "${CHAIN:=base_sepolia}"

if [[ -z "${PRIVATE_KEY:-}" ]]; then
  echo "PRIVATE_KEY not set. cp .env.example .env and fill it." >&2
  exit 1
fi

# load .env if present (without exporting secrets to ps)
if [[ -f .env ]]; then set -a; source .env; set +a; fi

mkdir -p deployments
forge create --rpc-url "$RPC_URL" --chain-id "$CHAIN_ID" \
  --private-key "$PRIVATE_KEY" \
  contracts/AEGIS.sol:AEGIS \
  --constructor-args "$PRIVATE_KEY" 2>&1 | tee deployments/aegis-sepolia.log

echo "=== AEGIS deployed. Fill AEGIS_TOKEN in .env, then rerun for AMM/Vault ==="
echo "Deployed addresses recorded in deployments/aegis-sepolia.log"
echo "Next: forge create AegisAMM + BridgeVault with AEGIS_TOKEN, seed pool, start keeper:bridge"
