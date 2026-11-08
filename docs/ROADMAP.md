# AEGIS Roadmap (v1.1 → v2.0)

## v1.1 (этот релиз)
- Дизайн v1.0: Explorer redesign, Wallet PWA, Design System
- Защита v1.0: AMM CEI/slippage, vault bounds, mint cap, hybrid size guards, liveness binding, 35 ts + 10 forge
- Комплекс v1.1: RPC faucet/registerValidator/metrics, Staking+Governance+Multisig контракты, Shamir backup в кошельке, RPC settings, explorer gov/bridge panels, Docker hardening, SDK/Tutorial/Tokenomics, 40 ts + 16 forge

## v1.12 — Trust hardening (сделано)
- **TOFU key binding**: аккаунт без `edPublic` больше не может тратить без подписи
- **Passkey по-настоящему**: WebAuthn PRF wrap + серверная проверка registration/assertion, tx-bound challenge
- **Fee market**: EIP-1559-lite base fee, `aeg_gasPrice`/`aeg_feeHistory`, кошелёк цитирует цену
- **Light client**: доменно-разделённое Merkle-дерево состояния + `aeg_getProof`, проверка в браузере
- Единый `VERSION` (core-ts/version.ts) — дрейф с package.json ловится тестом

## v1.13 — Light client & durability (сделано)
- **Signed checkpoints**: `stateRoot + blockHash` подписан гибридно, порог ≥2/3 стейка (6667 bps),
  авто-подпись каждые 10 блоков, store на 256 последних, `aeg_checkpointLatest|getCheckpoints|checkpointSign`
- **Header sync**: `verifyHeaderChain` — height/prevHash, пересчёт `headerHash`, гибридная
  подпись, stake-weighted VRF пропозера, якорь от checkpoint (`aeg_getHeaders|verifyHeaders|validatorSet`)
- **Tx inclusion proofs**: `aeg_getTxProof` против `header.merkleRoot`
- **WAL durability**: append-only NDJSON + `replayWal` (идемпотентный, терпит torn tail),
  snapshot раз в 1000 блоков вместо полной перезаписи на каждый блок
- Explorer: вкладка **Light client** — checkpoint + связка заголовков + Ed25519 в WebCrypto

## v1.14 — Offline trust & rollback defence (сделано)
- **Nullifier commitments**: набор потрат в `stateRoot` (`nullifiers:<root>`), checkpoint v2
  подписывает `nullifierRoot`; `aeg_isNullifierSpent` + `aeg_getNullifierRoot`
- **Non-inclusion proofs**: два соседних листа + проверка смежности; inclusion = «потрачен»;
  explorer пересчитывает путь и сравнивает root с checkpoint в браузере
- **Checkpoint pinning**: `core-ts/pinning.ts` — rollback/fork detection, пин никогда не
  понижается; кошелёк и explorer показывают предупреждение «узел показал другую историю»
- Миграция: checkpoint v1 (без nullifierRoot) не принимается store'ом — честный отказ вместо
  ложного якоря

## v1.4 — Production hardening (осталось)
- Slither cleanup в CI + external audit (Trail of Bits/Zellic), bug bounty escrow
- gossipsub для блоков (topic уже есть), checkpoint pinning в кошельке/explorer
- Expo native passkey + BLE mesh sync, push-нотификации
- Prometheus/Grafana манифесты, Base Sepolia deploy контрактов
- Nullifier-дерево: инкрементальный (sparse) update вместо пересборки на каждый блок

## v2.0 — Trust Mode
- Hard-fork «Trust Mode»: real USDC bridge + mainnet settlement, листинг LP
- E-ink hardened UI, Shamir 3-of-5 UI в native app, STARK-батчи PQ-ключей (1952B on-chain → hash commitment)
- Межчейн: Lumen ↔ AEGIS HTLC, CosmWasm-адаптер

## Дальше (исследование)
- FHE intent confidentiality, zk-humanity (доказать liveness без раскрытия биометрии)
- DTN LoRa/USB реальные транспорты, satellite relay

> каждый пункт — отдельный коммит с тестами. Не продаём «будущее», продаём trust layer.
