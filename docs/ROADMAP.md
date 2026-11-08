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

## v1.15 — Кошелёк проверяет себя сам (сделано)
- **Trustless balance в кошельке**: `wallet-mobile/src/lib/light.ts` — checkpoint
  (Ed25519 + ML-DSA-65, порог 2/3), заголовки от якоря `cp.height+1`, VRF-пропозер,
  Merkle proof против `cp.stateRoot`; кнопка «✓ проверить без доверия»
- **Честная деградация**: устаревший checkpoint → «баланс не подтверждён», а не
  «наверное, верный»; заголовки проверяются независимо от свежести состояния
- **Совместимость кошелька и ядра**: `hybrid = sha256(base64(edSig) ‖ base64(mlSig))` —
  раньше кошелёк хешировал hex-подпись, и узел отклонял **каждую** его транзакцию
  (`bad hybrid sig`); кросс-тесты `wallet-mobile/test/compat.test.ts`
- **noble v2 SHA-512**: `noble-setup.ts` ставит `ed.etc.sha512Sync` — без него
  `getPublicKey/sign/verify` падают в браузере и в node
- CI: `cd wallet-mobile && npm ci && npm test && npm run build`

## v1.16 — Сеть из нескольких узлов (сделано)
- **Sync без ложных банов**: `classifyBlock` (next/duplicate/gap/fork) + `SyncTracker`
  (cooldown, экспоненциальный backoff, отсечка мёртвых пиров); gap → `sync_request`
- **Bootstrap с переподключением**: одиночный `connect()` больше не оставляет узел
  в изоляции при `ECONNREFUSED`
- **Мультиватор devnet**: `AEGIS_VALIDATOR_SEED` (строка → sha256), общий
  `AEGIS_GENESIS_VALIDATORS` (сортированное применение → одинаковый stateRoot),
  слоты по часам (иначе узлы перестают предлагать блоки)
- **Кворум ≥2/3 видимого стейка**: изолированный узел блоки не производит
- **Checkpoint-кворум**: `aeg_checkpointOffer` — сосед подписывает только свой tip;
  `AEGIS_CHECKPOINT_PEERS`, слияние подписей, ретраи
- `aeg_syncStatus`, `/metrics {peer_count, forks_seen}`, `npm run devnet:multi`
- Проверено: 3 узла → одинаковые head/stateRoot, 3 пропозера, checkpoint 6667 bps

## v1.4 — Production hardening (осталось)
- Slither cleanup в CI + external audit (Trail of Bits/Zellic), bug bounty escrow
- fork-choice / реорганизация: сейчас форк только наблюдается (нет переключения ветки)
- headers-first догон вместо блоков (дешевле для длинного отставания)
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
