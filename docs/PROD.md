# AEGIS Production Deploy (v1.10)

## Env vars

| Var | Default | Для чего |
|---|---|---|
| `PORT` / `AEGIS_PORT` | 8899 | RPC+explorer |
| `P2P_PORT` / `AEGIS_P2P_PORT` | 3899 | P2P TCP-lite (libp2p = +1000) |
| `AEGIS_STATE_FILE` | `~/.local/state/aegis-chain.json` | snapshot + WAL рядом |
| `AEGIS_FAUCET` | `on` | `off` — выключить faucet в prod |
| `AEGIS_ADMIN_TOKEN` | empty (dev) | **prod обязан**: header `X-Admin-Token` для faucet/slash/register/commit/prune |
| `AEGIS_RPC_RATE_LIMIT` | 100/s/IP | 429 при превышении |
| `AEGIS_LOG_LEVEL` | info | debug/info/warn/error (JSON stderr) |

## Prod checklist
- [ ] `AEGIS_ADMIN_TOKEN` выставлен (64 hex), bootstrap аддиты только с ним
- [ ] `AEGIS_FAUCET=off`, explorer за reverse-proxy (CORS * только для dev)
- [ ] State file на persistent volume, WAL backupeд cron `scripts/monitor.sh`
- [ ] Prometheus scrape `/metrics`, Grafana dashboard `infra/grafana-dashboard.json`
- [ ] `npx tsx cli/trustcheck.ts` — все PASS
- [ ] npm test + forge test + wallet build зелёные

## Rate limit / errors
- 429 `{code:-32002}` — per-IP token bucket, header `Retry-After`
- 413 `{code:-32001}` — тело >1MB
- 500 `{code:-32000}` — dispatch/ledger/chain отклонение
- Admin без токена при выставленном env → `admin token required`

## Graceful shutdown
SIGINT/SIGTERM → timer clear, p2p close, libp2p close await, http close, snapshot save. В K8s — preStop sleep 5s.
