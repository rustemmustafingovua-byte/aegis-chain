# AEGIS — криптовалюта, устойчивая к взлому и ИИ-агентам

> **Aegis** — от греч. *Αιγίς*, щит Афины.  
> Не «ещё одна монета», а **протокол уровня доверия**, который нельзя обмануть ни человеком-мошенником, ни роем ИИ-агентов.

## Идея в одном абзаце

90% «всё украли» в крипте — это не взлом SHA-256. Это:
1. украли сид-фразу через фишинг / вредонос,
2. заманили подписать вредоносную транзакцию (prompt-injection для человека и для агента),
3. прогнали миллион автоматических попыток (перебор, scraping, MEV-боты, агенты).

AEGIS строится наоборот: **даже если у атакующего есть агент, который быстрее и умнее тебя — он всё равно не пройдёт.**

Три рубежа:

| Рубеж | Что защищает | Ключевая фишка |
|---|---|---|
| **1. PQ-криптография** | Квантовые компьютеры, «собери сейчас — расшифруй потом» | Гибридные подписи: классика + решетки (ML-DSA/Lattice) + хеш-время |
| **2. Порбог ключей** | Кража одного ключа / вредонос на одном устройстве | 3-из-5 Shamir + аппаратный якорь + эфемерные сессии |
| **3. Anti-AI Shield** | Агенты, фишинг, prompt-injection, автобрут | Intent-binding + Proof-of-Liveness + Behavioral scoring |

## Быстрый старт

### v0.1 Python prototype
```bash
cd ~/workspace/workspace/aegis-chain
python3 demo.py        # демо: нормальный юзер проходит, 4 атаки — нет
python3 -m pytest test_aegis.py -v   # тесты
```

### v1.15 — Кошелёк проверяет баланс сам: checkpoint + PQ в браузере (сделано)
- **Trustless balance**: кнопка «✓ проверить без доверия» в кошельке прогоняет
  `aeg_validatorSet → aeg_checkpointLatest → aeg_getHeaders(cp.height+1…) → aeg_getProof`
  и пересчитывает Merkle-путь **в браузере**; ML-DSA-65 проверяется локально
  (`@noble/post-quantum`), а не узлом
- **Честная деградация**: устаревший checkpoint → «баланс не подтверждён», заголовки
  при этом всё равно проверяются (непрерывность истории доказана)
- **Исправлена критическая несовместимость**: кошелёк считал
  `hybrid = sha256(hex(edSig) ‖ base64(mlSig))`, ядро — `sha256(base64 ‖ base64)`,
  поэтому **каждая** транзакция из кошелька отклонялась с `bad hybrid sig`
- **noble v2**: `lib/noble-setup.ts` ставит `ed.etc.sha512Sync` (без него
  `getPublicKey/sign/verify` падают и в браузере, и в node)
- **Тесты кошелька** в CI: `npm test` внутри `wallet-mobile/` (8 тестов)

### v1.14 — Offline trust: nullifier proofs и защита от отката (сделано)
- **Nullifier-обязательство** в `stateRoot`; checkpoint v2 подписывает `nullifierRoot`
- **Non-inclusion proofs**: «этот офлайн-пакет ещё не потрачен» доказывается по подписанному
  checkpoint, без полного узла; explorer проверяет путь Меркла в браузере
- **Pinning**: кошелёк и explorer закрепляют последний проверенный checkpoint и ловят
  **rollback** (узел откатил высоту) и **fork** (другая история на той же высоте)
- Миграция: v1-checkpoint'ы без `nullifierRoot` не принимаются

### v1.13 — Light client, checkpoints и durable WAL (сделано)
- **Checkpoints**: `stateRoot + blockHash` подписаны гибридно (Ed25519 + ML-DSA-65), порог ≥2/3
  стейка, авто каждые N блоков, `aeg_checkpointLatest|getCheckpoints|checkpointSign`
- **Header sync**: `aeg_getHeaders|verifyHeaders|validatorSet` — height/prevHash, пересчёт хеша,
  гибридная подпись и VRF-пропозер, якорь от checkpoint
- **Tx inclusion proof**: `aeg_getTxProof` против `header.merkleRoot`
- **WAL**: append-only NDJSON + `replayWal` с терпимостью к torn tail; snapshot раз в 1000 блоков
  вместо полной перезаписи на каждый блок
- **Explorer**: вкладка **Light client** — checkpoint-кворум, связка заголовков, Ed25519 в WebCrypto
- **CLI**: `aegis send --to … --amount …` (подпись гибридная, nonce/fee из RPC)

### v1.13 TypeScript Chain (как Lumen) + ML-DSA + Mesh + Infra + Light client
```bash
cd ~/workspace/workspace/aegis-chain
npm install
npm test               # 79 passing (ядро) + 8 в wallet-mobile + 31 forge: hybrid, Chain, Shamir, Mesh, P2P, RPC, AMM, Governance, Bridge, security, fee market, Merkle proofs, WebAuthn/Passkey, signed checkpoints, header sync, nullifier proofs, WAL replay, light-client
npm run demo           # Ed25519+ML-DSA-65, intent, offline mesh, PoS block
npm run build          # tsc → dist/
npm run serve          # :8899 RPC+Explorer, :3899 TCP + :4899 libp2p Noise (живой узел, WAL + checkpoints)
npm run keeper         # автономный конвертер USDC→AEGIS
npx tsx cli/aegis.ts send --to=aeg1... --amount=1000 --intent="оплата"
```

Devnet heartbeat (чтобы цепь росла без транзакций и появлялись чекпоинты):

```bash
AEGIS_EMPTY_BLOCK_SLOTS=15 AEGIS_CHECKPOINT_EVERY=2 npm run serve
```

Проверка лёгкого клиента без доверия узлу:

```bash
curl -s :8899/api/rpc -d '{"jsonrpc":"2.0","id":1,"method":"aeg_checkpointLatest","params":[]}' -H 'Content-Type: application/json'
curl -s :8899/api/rpc -d '{"jsonrpc":"2.0","id":2,"method":"aeg_getHeaders","params":[0,20]}' -H 'Content-Type: application/json'
curl -s :8899/api/rpc -d '{"jsonrpc":"2.0","id":3,"method":"aeg_getTxProof","params":[1,0]}' -H 'Content-Type: application/json'
```

Публичный devnet-URL (переменный, обновляется keepalive): `~/.local/state/aegis-url.txt`.

### Мобильный кошелёк с Passkey (v1.0 — bottom nav, QR mesh, shield checklist, PWA)
```bash
cd wallet-mobile
npm install
npm test               # 8 тестов: совместимость подписей с ядром + light client
npm run test:live      # e2e против живого devnet: tx из кошелька + trustless balance
npm run dev            # → http://localhost:5188
npm run build          # ~334KB gzip ~109KB — PWA manifest + icon
# iPhone/Android: создай Passkey (Touch/Face ID), кошелёк шифруется им
```

## Полная инфраструктура (v1.15)

| Компонент | Где | Запуск |
|---|---|---|
| **Chain** PoS 2/3 + Hybrid блоки | `core-ts/chain.ts`, `ledger.ts` | `npm run demo` |
| **PQ-криптография** ML-DSA-65 (Dilithium3, FIPS 204) | `core-ts/hybrid.ts` (`@noble/post-quantum`) | — |
| **Anti-AI Shield** Intent, Liveness, Behavioral | `core-ts/aegis.ts` | — |
| **Mesh автономия** DTN epidemic, QR/BLE/LoRa | `core-ts/mesh.ts`, `autonomy.ts`, `docs/MESH.md` | `npm run mesh:demo` |
| **P2P сеть** TCP gossip (blocks/txs/sync) | `core-ts/p2p.ts` | `aegis serve` |
| **RPC** JSON-RPC 2.0 + REST + faucet/metrics | `core-ts/rpc.ts`, `GET /api/state`, `/metrics` | `POST /api/rpc` |
| **Explorer** живой, отдаётся узлом (KPI, sparkline, hybrid-verify, gov/bridge, light-client proof) | `explorer/index.html`, `docs/DESIGN.md` | `GET /` |
| **Fee market** EIP-1559-lite base fee + `aeg_gasPrice` | `core-ts/fee.ts`, `docs/FEE.md` | авто |
| **Light client** Merkle state proofs (`aeg_getProof`) | `core-ts/merkle.ts`, `docs/LIGHT_CLIENT.md` | `POST /api/rpc` |
| **Signed checkpoints** ≥2/3 стейка, авто каждые 10 блоков | `core-ts/checkpoints.ts`, `docs/LIGHT_CLIENT.md` | `aeg_checkpointLatest` |
| **Header sync** цепочка заголовков + VRF-проверка пропозера | `core-ts/headers.ts` | `aeg_getHeaders` / `aeg_verifyHeaders` |
| **Tx inclusion proof** против `header.merkleRoot` | `core-ts/rpc.ts` (`aeg_getTxProof`) | `POST /api/rpc` |
| **WAL durability** append-only лог + replay с терпимостью к torn tail | `core-ts/wal.ts`, `docs/WAL.md` | авто |
| **Nullifier proofs** inclusion/non-inclusion по подписанному checkpoint | `core-ts/nullifiers.ts`, `docs/LIGHT_CLIENT.md` | `aeg_isNullifierSpent` |
| **Checkpoint pinning** rollback/fork detection в кошельке и explorer | `core-ts/pinning.ts`, `wallet-mobile/src/lib/pin.ts` | авто |
| **Wallet light client** баланс доказан целиком (checkpoint + headers + proof), ML-DSA в браузере | `wallet-mobile/src/lib/light.ts`, `docs/LIGHT_CLIENT.md` | кнопка в кошельке |
| **Passkey server** WebAuthn registration/assertion, TOFU key binding | `core-ts/webauthn.ts`, `docs/PASSKEY.md` | авто |
| **Keeper** конвертер без биржи (AMM x*y=k 0.3%) | `keeper/keeper.ts` | `npm run keeper` |
| **Контракты Base** ERC-20 + AMM + Staking + Governance + Multisig | `contracts/` | `forge create` |
| **Mobile Wallet** Passkey, Shamir 3-of-5, trustless balance, QR, history, shield | `wallet-mobile/` | `npm run dev` |
| **CI/CD** GH Actions (slither, wallet), Docker hardened, keepalive | `.github/workflows/ci.yml`, `scripts/`, `Dockerfile` | — |

Документация: `docs/FEE.md`, `docs/LIGHT_CLIENT.md`, `docs/WAL.md`, `docs/PASSKEY.md`, `docs/PROD.md`, `docs/DESIGN.md`, `docs/SDK.md`, `docs/TUTORIAL.md`, `docs/TOKENOMICS.md`, `docs/ROADMAP.md`, `docs/API.md`, `docs/OPS.md`, `docs/THREAT_MODEL.md`, `docs/INFRA.md`, `docs/MESH.md`, `docs/MOBILE.md`, `ARCHITECTURE.md`

## Токеномика (черновик)

- **LMN-подобная эмиссия, но с привязкой к proof-of-humanity:** 1e9 AEGIS, 60% казначейской, 40% валидаторам, 3% годовых, халвинг 4 года.
- **Нет «биржевой» торговли без кошелька:** AEGIS не листится как спекулятивный актив, пока не пройден hard-fork «Trust Mode».
- **Сборы за Anti-AI проверки:** комиссии идут в пул аудиторов и в страхование жертв (escrow 180 дней).

## Почему это нужно в 2026

ИИ-агенты уже:
- генерируют 10 000 фишинговых сайтов в час,
- находят 0-day в кошельках за минуты,
- обходят капчи,
- делают social-engineering точнее человека.

Традиционная крипта защищает **ключи**. AEGIS защищает **намерение человека**.

> «Главное — не кто подписал, а *зачем* и *живой ли это человек прямо сейчас*».

---

Создано как концепт-прототип. Не является финансовой рекомендацией.
