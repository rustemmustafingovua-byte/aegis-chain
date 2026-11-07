#!/usr/bin/env bash
# AEGIS Deploy All v1.1 — forge create for all contracts on Base Sepolia
set -euo pipefail
cd "$(dirname "$0")/.."
: "${RPC_URL:=https://sepolia.base.org}"
: "${CHAIN_ID:=84532}"
if [[ -z "${PRIVATE_KEY:-}" ]]; then echo "PRIVATE_KEY not set. cp .env.example .env" >&2; exit 1; fi
if [[ -f .env ]]; then set -a; source .env; set +a; fi
mkdir -p deployments
forge create --rpc-url "$RPC_URL" --chain-id "$CHAIN_ID" --private-key "$PRIVATE_KEY" contracts/AEGIS.sol:AEGIS 2>&1 | tee deployments/aegis-sepolia.log
echo "Fill AEGIS_TOKEN in .env, then:"
echo "  forge create contracts/AegisAMM.sol:AegisAMM --constructor-args \$AEGIS_TOKEN \$USDC_ADDRESS"
echo "  forge create contracts/BridgeVault.sol:BridgeVault --constructor-args \$USDC_ADDRESS"
echo "  forge create contracts/AegisStaking.sol:AegisStaking --constructor-args \$AEGIS_TOKEN"
echo "  forge create contracts/AegisGovernance.sol:AegisGovernance --constructor-args \$AEGIS_TOKEN"
echo "  forge create contracts/AegisMultisig.sol:AegisMultisig --constructor-args '[owner1,owner2]' 2"
