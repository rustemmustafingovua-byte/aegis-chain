# AEGIS Monitoring (v1.2)

## Endpoints
- `GET /health` → `{ok, height, version}`
- `GET /metrics` → Prometheus text (`aegis_height`, `aegis_mempool`, `aegis_blocks`, `aegis_accounts`, `aegis_validators`, `aegis_supply`, `aegis_uptime_seconds`)
- `POST /rpc aeg_metrics` → JSON форма метрик
- `aeg_snapshot` → `{hash,height,stateRoot,size}` для архивов
- `aeg_prune [keepN]` → усечение старых блоков (PRUNE_HEIGHT bump, но Ledger state цел)

## Prometheus
```yaml
# infra/prometheus.yml уже настроен на aegis-node:8899/metrics
```

## Grafana
Импорт `infra/grafana-dashboard.json` (5 панелей: height/mempool/blocks/supply/uptime).

## docker-compose
```bash
docker compose up --build
# нода: :8899/3899/4899, healthcheck wget /health
```

## Alerts (предложение)
- height не растёт 5 слотов при mempool>0 → proposer/VRF check
- mempool > 1000 → spam check (fee priority, size caps)
- peer score ≤−100 → ban логи, смотри libp2p лог
