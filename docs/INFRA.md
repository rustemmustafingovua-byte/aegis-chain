# AEGIS Infra — полная инфраструктура (v0.9)

## Карта

```
┌─────────────────────────────────────────────┐
│  wallet-mobile (PWA, Passkey) :5188         │
│  hybrid Ed25519+ML-DSA-65, intent UI, mesh QR│
└──────────────────┬──────────────────────────┘
                   │ JSON-RPC
┌──────────────────▼──────────────────────────┐
│ aegis serve --port=8899                      │
│  chain (PoS 2/3) + ledger + mempool         │
│  /api/rpc  /api/state  /health              │
│  explorer/index.html (статика)              │
│  P2P TCP :3899 + libp2p Noise :4899 (v0.9) gossip blocks/txs          │
└──────────────────┬──────────────────────────┘
                   │ Base / mesh
┌──────────────────▼──────────────────────────┐
│ keeper/keeper.ts + keeper/bridge-watcher.ts — автономный конвертер      │
│  USDC/ETH → AEGIS via AMM (x*y=k, 0.3%)     │
│  пишет блоки сам, без биржи                 │
└─────────────────────────────────────────────┘
      contracts/  AEGIS.sol, AegisAMM.sol (Base)
      scripts/aegis-keepalive.sh (+ tunnel-ensure)
```

## Запуск

```bash
npm run serve          # :8899 RPC+Explorer, :3899 P2P
npm run explorer       # алиас serve
npm run keeper         # демо конвертера
npm run node           # cli node helper

# prod keepalive (launchd cron 1 мин)
bash scripts/aegis-keepalive.sh
# URL туннеля: ~/.local/state/aegis-url.txt
```

## RPC

```
POST /api/rpc  {"jsonrpc":"2.0","id":1,"method":"aeg_getState","params":[]}
  aeg_getState | aeg_getBlock(height) | aeg_getBlocks(n)
  aeg_getBalance(addr) | aeg_getAccount(addr)
  aeg_sendTx(tx) | aeg_meshStatus | aeg_sync

GET  /api/state  -> { height, head, supply, accounts[], blocks[] }
GET  /health     -> { ok:true, height, version:"0.9.0" }
```

## P2P

TCP newline-JSON: `hello, new_block, new_tx, sync_request/response, mesh_packet`.
LP в проде: заменить на libp2p + Noise/TLS; сейчас чистый `node:net` для аудита.

## Mesh (offline)

- Транспорты: QR (~500B), BLE (185B chunks), WiFi Direct, LoRa (51-242B), USB sneakernet.
- Один пакет = `OfflineTx` из `core-ts/autonomy.ts` (nullifier + hybrid sig).
- Дедуп: `txHash` + `nullifier`. Конфликт двойной траты: lowest `txHash` wins.
- Store-carry-forward: `queueForCarry` → `flushCarry` при встрече.

## Валидаторы

Запуск: `hybridGenerate(seed)` → `chain.addValidator(pub, mlPubB64, stake)`.
- PoS вес = stake. Продюсер слота детерминирован (`proposerForSlot`).
- Блок = hybrid подпись продюсера (Ed25519 + ML-DSA). Merkle корень по txs.

## Безопасность

- ML-DSA pk 1952B on-chain: в проде коммиттить hash, полный pk — в mesh/peer.
- Skill: Passkey unwrap = AES‑GCM(HKDF(passkey_sig || local_entropy)).
- Rate-limit по `human_context_hash`, не по IP.

## Артефакты

- `dist/` — скомпилированный ESM (`npm run build`)
- `wallet-mobile/dist/` — PWA статика
- `deployments/` — forge адреса (после `forge create`)
- `explorer/index.html` отдаётся самим узлом
