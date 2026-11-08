# AEGIS WAL & Persistence (v1.13)

## Файлы состояния

| Файл | Что внутри | Когда пишется |
|---|---|---|
| `~/.local/state/aegis-chain.json` | snapshot: blocks + ledger + validators | каждые `WAL_SNAPSHOT_EVERY` (1000) блоков, при остановке |
| `~/.local/state/aegis-chain.wal.ndjson` | append-only NDJSON, один блок на строку | после каждого произведённого блока |
| `~/.local/state/aegis-chain-passkeys.json` | PasskeyRegistry (credential → аккаунт) | после каждого блока |
| `~/.local/state/aegis-chain-checkpoints.json` | подписанные checkpoints (последние 256) | при создании checkpoint (каждые 10 блоков) |

## Поток записи (server.ts)

```
produceNextBlock()
  ├─ wal.append(block)              # O(1) append + fsync каждые 100
  ├─ height % 10 == 0  → createCheckpoint + save
  └─ height % 1000 == 0 → wal.compact(chain)   # snapshot + очистка WAL
```

До v1.13 каждый блок вызывал `chain.saveToFile()` — полная перезапись JSON всей цепи.
На длинной цепи это O(размер цепи) на блок. Теперь на блок — только append.

## Поток старта (восстановление после краша)

```ts
const chain = Chain.loadFromFile(stateFile) ?? genesisChain();
const { walPath } = walPaths(stateFile);
const r = replayWal(chain, walPath);
// r = { applied, skipped, corrupt, height }
```

`replayWal` (`core-ts/wal.ts`):

1. читает WAL построчно;
2. блок с `height <= chain.height` → `skipped` (идемпотентность: повторный реплей безопасен);
3. блок с `height === chain.height + 1` → `chain.accept(block)`, `applied++`;
4. **torn tail**: невалидный JSON (обрыв записи посреди строки), блок без `header.height`
   или разрыв высот → `corrupt = true` и цикл останавливается на последнем валидном
   префиксе. Валидные блоки перед обрывом не теряются;
5. отсутствующий WAL — это нормально (`applied=0`).

Свойства:

- **Durability**: блок, для которого append вернулся, переживает kill -9 (fsync батчами
  по 100; потерять можно только последние <100 блоков, и только при отказе ОС).
- **Idempotency**: повторный запуск не дублирует блоки.
- **Forward-only recovery**: WAL не откатывает цепь назад; если snapshot новее WAL,
  старые строки просто скипаются.
- **No silent corruption**: `corrupt` попадает в лог (`wal replay { applied, skipped,
  corrupt, height }`), и узел продолжает с валидного префикса.

## RPC

- `aeg_walStatus` → `{ wal, height, blocks, snapshotEvery }`
- `aeg_snapshot` → hash/height/stateRoot/size
- `aeg_prune [keepN]` → усечение старых блоков (admin)

## Метрики

Prometheus `/metrics` не содержит WAL отдельно — используй RPC `aeg_walStatus` и лог
`wal replay` при старте.

## Тесты

`test-ts/v113.test.ts` → `v1.13 wal: replay restores blocks after the last snapshot,
torn tail tolerated`: snapshot на высоте 0 → 3 блока в WAL → реплей восстанавливает
height 3 и тот же `stateRoot`; повторный реплей `applied=0, skipped=3`; дописанная
обрезанная строка даёт `corrupt=true`, но цепь остаётся на height 3.
