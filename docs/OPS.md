# AEGIS OPS Runbook (v1.0)

## Запуск ноды (devnet)

```bash
npm ci && npm run build
npm run serve -- --port=8899
# P2P TCP-lite :3899, libp2p Noise :4899, RPC+explorer :8899
# health: curl :8899/health; state: curl :8899/api/state
```

State file: `~/.local/state/aegis-chain.json` (devnet genesis, детерминированный валидатор `aeg12Azq…`, AMM seeded). Удаление файла = новый genesis.

## Docker

```bash
docker compose up --build
curl :8899/health
```

## Keepalive (launchd, как lumen)

`scripts/aegis-keepalive.sh` — проверить процесс `:8899`, рестарт при падении.
Добавить launchd `com.aegis.chain` (каждую минуту): интервал 60, лог `~/.local/state/aegis.log`.

## Wallet

```bash
cd wallet-mobile && npm i && npm run dev   # :5188, нужен localhost/HTTPS для Passkey
npm run build                              # dist/ → PWA (manifest + icon)
```

RPC для баланса: `localStorage.setItem('aegis.rpc','http://127.0.0.1:8899/rpc')`.

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
| validator не продюсит | proposerForSlot(slot) ≠ validator.edPublic; slot растёт только при mempool>0 |
| Passkey не работает | нужен HTTPS/localhost, не IP; включи WebAuthn в браузере |

## Deploy Sepolia

См. `docs/DEPLOY.md`: `.env` burner, `bash scripts/deploy-sepolia.sh`, заполнить адреса, seed AMM, keeper.

## Бэкап

State file снапшотится после каждого блока (`saveToFile`). Prod: async WAL вместо sync write.
