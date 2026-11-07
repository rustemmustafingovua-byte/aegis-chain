# AEGIS WAL & Persistence (v1.3)

## Два файла
- **Snapshot:** `~/.local/state/aegis-chain.json` — full Chain.serialize() (blocks+ledger+validators)
- **WAL:** `~/.local/state/aegis-chain.wal.ndjson` — append-only NDJSON блоков (stringify per block)

## Поток (server.ts)
- Каждый произведённый блок → `Wal.append(block)` + `fsync` каждые 100
- Каждые `WAL_SNAPSHOT_EVERY=1000` блоков → `compact()`: snapshot + WAL clear
- На старте: `Chain.loadFromFile(snapshot)` как раньше; WAL — durable лог для аудита/реплея

## RPC
- `aeg_walStatus` → walBlocks, walBytes, height
- `aeg_snapshot` → hash/height/stateRoot/size
- `aeg_prune [keepN]` → усечение старых блоков

## Метрики
Промetheus `/metrics` не содержит WAL отдельно — используй RPC `aeg_walStatus`.
