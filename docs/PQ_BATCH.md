# AEGIS PQ Batch & Offline-first (v1.8)

## ML-DSA hash commitment (Stark-precursor)
- Полный ML-DSA публичный ключ 1952B — много для on-chain. Храним **hash commitment** on-chain, полный ключ — off-chain.
- RPC `aeg_commitMlKey [addr, mlHash, mlPublicKeyB64?]`:
  - Без ключа: только hash валидация (64 hex)
  - С ключом: проверка hash + 1952B размер
- Ledger account: `mlPublicHash` поле (уже есть), верификация tx — hybridVerify с полным ключом из mempool (не из цепи)

## Sneaker transport (USB/BLE-file DTN)
- `core-ts/sneaker.ts`: `sneakerExport(node, file)` → base64 packets, `sneakerImport(file, nodes)` → receive loop
- `scripts/sneaker-sync.sh src dst` — USB флэшка между машинами
- LoRa: аналогично через serial файл (портируется 1:1)

## PWA offline
- `wallet-mobile/public/sw.js`: install cache app shell (`/` + manifest), fetch network-first + cache fallback для GET, POST — network only
- `main.tsx` регистрирует SW. Офлайн: shell грузится, подписанные tx хранятся в history, отправка — при ре-connected

## HTLC interchain (см. INTERCHAIN.md)
- `contracts/AegisHTLC.sol`: generic fund/claim/refund, timelock 60s..30d, counterparty field для Lumen watcher
