# AEGIS Deploy — Base Sepolia Testnet v0.9

## 1. Prerequisites

- Foundry: `curl -L https://foundry.paradigm.xyz | bash && foundryup`
- Base Sepolia RPC: `https://sepolia.base.org` (chain 84532)
- Burner wallet funded with testnet ETH (Coinbase Faucet: https://faucet.coinbase.com)

## 2. Deploy contracts

```bash
cp .env.example .env
# fill PRIVATE_KEY (burner, testnet only) in .env
bash scripts/deploy-sepolia.sh
# fills deployments/aegis-sepolia.log — copy AEGIS_TOKEN into .env
```

Then deploy AMM + vault (same pattern, replace addresses in `.env`):

```bash
forge create --rpc-url $RPC_URL --private-key $PRIVATE_KEY \
  contracts/AegisAMM.sol:AegisAMM --constructor-args $AEGIS_TOKEN $USDC_ADDRESS
forge create --rpc-url $RPC_URL --private-key $PRIVATE_KEY \
  contracts/BridgeVault.sol:BridgeVault --constructor-args $USDC_ADDRESS
```

## 3. Seed AMM pool + start keeper

```bash
# seed AEGIS/USDC pool, then:
AEGIS_BRIDGE_VAULT=<vault> npm run keeper:bridge
AEGIS_RPC_URL=http://127.0.0.1:8899/rpc npm run keeper
```

## 4. Run a node (libp2p Noise, port 3899)

```bash
npm run serve -- --port=8899
# health: curl http://127.0.0.1:8899/health -> {"ok":true,"version":"0.9.0"}
# state:  curl http://127.0.0.1:8899/api/state
# quote:  curl -X POST http://127.0.0.1:8899/api/rpc -H 'Content-Type: application/json' \
#           -d '{"jsonrpc":"2.0","id":1,"method":"aeg_swapQuote","params":["1000000"]}'
```

libp2p multiaddr is logged at startup: `/ip4/0.0.0.0/tcp/3899/p2p/12D3...`.
Share it via `core-ts/discovery.ts` BOOTSTRAP so peers auto-dial.

## 5. Mobile wallet (testnet)

```bash
cd wallet-mobile && npm i && npm run dev
# PWA: Passkey unwrap via AES-GCM + HKDF(passkey_sig || local_entropy)
# See docs/MOBILE.md for Expo BLE mesh sync (roadmap).
```

## Trust Mode gate

Do not accept mainnet USDC or deploy to Base mainnet until `SECURITY.md` checklist is fully green
(Slither clean + invariants + external review). Testnet only until then.
