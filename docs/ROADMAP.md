# AEGIS Roadmap (v1.1 → v2.0)

## v1.1 (этот релиз)
- Дизайн v1.0: Explorer redesign, Wallet PWA, Design System
- Защита v1.0: AMM CEI/slippage, vault bounds, mint cap, hybrid size guards, liveness binding, 35 ts + 10 forge
- Комплекс v1.1: RPC faucet/registerValidator/metrics, Staking+Governance+Multisig контракты, Shamir backup в кошельке, RPC settings, explorer gov/bridge panels, Docker hardening, SDK/Tutorial/Tokenomics, 40 ts + 16 forge

## v1.2 — Production hardening
- Slither в CI + external audit (Trail of Bits/Zellic), bug bounty escrow, multisig timelock UX
- gossipsub миграция (заменить stream gossip на topic `/aegis/1.0/gossip` без смены валидации)
- Expo Passkey + BLE mesh sync, QR scan camera, push-нотификации
- Prometheus/Grafana манифесты, checkpoint snapshots, WAL persistence

## v2.0 — Trust Mode
- Hard-fork «Trust Mode»: real USDC bridge + mainnet settlement, листинг LP
- E-ink hardened UI, Shamir 3-of-5 UI в native app, STARK-батчи PQ-ключей (1952B on-chain → hash commitment)
- Межчейн: Lumen ↔ AEGIS HTLC, CosmWasm-адаптер

## Дальше (исследование)
- FHE intent confidentiality, zk-humanity (доказать liveness без раскрытия биометрии)
- DTN LoRa/USB реальные транспорты, satellite relay

> каждый пункт — отдельный коммит с тестами. Не продаём «будущее», продаём trust layer.
