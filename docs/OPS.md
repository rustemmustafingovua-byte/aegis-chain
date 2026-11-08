# AEGIS OPS Runbook (v1.13)

## Запуск ноды (devnet)

```bash
npm ci && npm run build
npm run serve -- --port=8899
# P2P TCP-lite :3899, libp2p Noise :4899, RPC+explorer :8899
# health: curl :8899/health; state: curl :8899/api/state
```

State files: `~/.local/state/aegis-chain.json` (snapshot), `aegis-chain-passkeys.json`,
`aegis-chain-checkpoints.json`, `aegis-chain.wal.ndjson` (append-only). Удаление всех = новый genesis.

### Переменные окружения (v1.13)

| Переменная | Смысл | Default |
|---|---|---|
| `AEGIS_EMPTY_BLOCK_SLOTS` | пустой блок каждые N слотов (0 = только при tx) — нужно для роста devnet и чекпоинтов | `0` |
| `AEGIS_CHECKPOINT_EVERY` | подписанный checkpoint каждые N блоков | `10` |
| `AEGIS_P2P_PORT` | P2P порт (иначе `port-5000`, т.е. 8899→3899) | derived |
| `AEGIS_STATE_FILE` | путь к snapshot | `~/.local/state/aegis-chain.json` |
| `AEGIS_ADMIN_TOKEN` | если задан — требуется для admin-RPC (`aeg_faucet`, `aeg_checkpointSign`, …) | пусто |
| `AEGIS_FAUCET=off` | отключить faucet | on |
| `AEGIS_RPC_RATE_LIMIT` | запросов/с на IP | `100` |

Devnet-профиль (используется keepalive): `AEGIS_EMPTY_BLOCK_SLOTS=15`,
`AEGIS_CHECKPOINT_EVERY=2` — ~1 блок/мин (4s слот × 15), чекпоинт ~раз в 2 минуты.

### Отправка транзакции из CLI

```bash
npx tsx cli/aegis.ts send --to=aeg1... --amount=1000 --rpc=http://127.0.0.1:8899 --intent="оплата"
# без --seed используется детерминированный devnet-ключ (тот же, что у serve)
```

## Docker

```bash
docker compose up --build
curl :8899/health
```

## Keepalive (launchd, как lumen)

`scripts/aegis-keepalive.sh` — проверить процесс `:8899`, рестарт при падении, туннель
(`tunnel-ensure.sh`: pinggy → localhost.run → bore). Публичный URL — `~/.local/state/aegis-url.txt`.

Установлено: launchd `com.aegis.node` (каждую минуту) исполняет
`~/.config/opencode/scripts/aegis-keepalive.sh` (копия repo-скрипта — launchd не имеет
доступа к чтению скриптов на внешнем томе), лог `~/.local/state/aegis-node.log`.

```bash
launchctl load ~/Library/LaunchAgents/com.aegis.node.plist
launchctl list | grep aegis
```

## Wallet

```bash
cd wallet-mobile && npm i && npm run dev   # :5188, нужен localhost/HTTPS для Passkey
npm test                                   # 8 тестов: кошелёк ↔ ядро + light client
npm run test:live                          # e2e против живого узла: tx из кошелька + proof баланса
npm run build                              # dist/ → PWA (manifest + icon)
```

RPC для баланса: `localStorage.setItem('aegis.rpc','http://127.0.0.1:8899/rpc')`.

Кнопка **«✓ проверить без доверия»** проверяет баланс локально (checkpoint-подписи
включая ML-DSA-65, заголовки, Merkle proof). Если она отвечает «не подтверждён —
состояние изменилось после checkpoint», это нормально для свежего devnet:
чекпоинт подписывается раз в `AEGIS_CHECKPOINT_EVERY` блоков (на devnet = 2).

| Симптом | Причина |
|---|---|
| `hashes.sha512Sync not set` | `@noble/ed25519` импортирован в обход `lib/noble-setup.ts` |
| «bad hybrid sig» от узла | подпись собрана не той каноничной строкой — см. `test/compat.test.ts` |
| «баланс не подтверждён» | `proof.root ≠ cp.stateRoot`; дождись следующего checkpoint или проверь headers |

## Мультиватор devnet (v1.16)

```bash
npm run devnet:multi                                   # :8901-:8903, Ctrl+C убивает все
CHECK_HEIGHT=6 npx tsx scripts/devnet-multi.ts --check # поднять, проверить, выйти
```

Свой ключ на узел: `AEGIS_VALIDATOR_SEED`; общий генезис: `AEGIS_GENESIS_VALIDATORS`;
подключение: `AEGIS_BOOTSTRAP=host:port`; ко-подписи: `AEGIS_CHECKPOINT_PEERS=url,url`.
Подробности и границы — `docs/NETWORK.md`.

| Симптом | Причина / действие |
|---|---|
| `proposal skipped: no quorum` | узел видит <2/3 стейка (нет пиров) — это защита, а не сбой |
| `forksSeen` растёт | два узла с одинаковым ключом или один остался без пиров — сверь `AEGIS_VALIDATOR_SEED`/генезис |
| узлы разъехались и не сходятся | нет реорганизации: перезапусти отставший узел с тем же `AEGIS_STATE_FILE` (догонит) или пересоздай devnet |

## Keeper / Bridge

```bash
npm run keeper                              # USDC→AEGIS AMM converter (daemon)
npm run keeper:bridge                       # Base Funded → AEGIS mint (AEGIS_BRIDGE_VAULT)
```

## Диагностика

| Симптом | Причина / действие |
|---|---|
| `/health` 404 | нода не поднята; смотри лог `serve` |
| `body too large` 413 | клиент шлёт >1MB — норма, обрежь tx |
| sync lag растёт | смотри `aeg_peerList`, peer score; бан при ≤−100 |
| block rejected | hybrid sig fail — проверь ключи, proposerForSlot, proposerForSlot детерминирован |
| validator не продюсит | proposerForSlot(slot) ≠ validator.edPublic; при пустом mempool нужен `AEGIS_EMPTY_BLOCK_SLOTS` |
| чекпоинтов нет | мемпул пуст и heartbeat выключен → цепь не растёт; включи `AEGIS_EMPTY_BLOCK_SLOTS` |
| `npx: No such file` под launchd | минимальный PATH — keepalive экспортирует homebrew/bin |
| `wal replay corrupt=true` | обрыв записи (kill -9): узел взял валидный префикс, смотри `wal replay` в логе |
| Passkey не работает | нужен HTTPS/localhost, не IP; включи WebAuthn в браузере |

## Deploy Sepolia

См. `docs/DEPLOY.md`: `.env` burner, `bash scripts/deploy-sepolia.sh`, заполнить адреса, seed AMM, keeper.

## Бэкап

State file снапшотится после каждого блока (`saveToFile`). Prod: async WAL вместо sync write.
