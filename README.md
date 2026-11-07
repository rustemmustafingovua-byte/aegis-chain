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

### v1.1 TypeScript Chain (как Lumen) + ML-DSA + Mesh + Infra + Дизайн
```bash
cd ~/workspace/workspace/aegis-chain
npm install
npm test               # 40 passing: hybrid, Chain, Shamir, Mesh, P2P, RPC, AMM, Governance, Bridge, security (size guards, domain binding, liveness, replay) + 16 forge tests (AMM CEI/slippage, vault bounds, mint cap, conservation)
npm run demo           # Ed25519+ML-DSA-65, intent, offline mesh, PoS block
npm run build          # tsc → dist/
npm run serve          # :8899 RPC+Explorer v1.0, :3899 TCP + :4899 libp2p Noise (живой узел)
npm run keeper         # автономный конвертер USDC→AEGIS
```

### Мобильный кошелёк с Passkey (v1.0 — bottom nav, QR mesh, shield checklist, PWA)
```bash
cd wallet-mobile
npm install
npm run dev            # → http://localhost:5188
npm run build          # 310KB gzip 102KB — PWA manifest + icon
# iPhone/Android: создай Passkey (Touch/Face ID), кошелёк шифруется им
```

## Полная инфраструктура (v1.1)

| Компонент | Где | Запуск |
|---|---|---|
| **Chain** PoS 2/3 + Hybrid блоки | `core-ts/chain.ts`, `ledger.ts` | `npm run demo` |
| **PQ-криптография** ML-DSA-65 (Dilithium3, FIPS 204) | `core-ts/hybrid.ts` (`@noble/post-quantum`) | — |
| **Anti-AI Shield** Intent, Liveness, Behavioral | `core-ts/aegis.ts` | — |
| **Mesh автономия** DTN epidemic, QR/BLE/LoRa | `core-ts/mesh.ts`, `autonomy.ts`, `docs/MESH.md` | `npm run mesh:demo` |
| **P2P сеть** TCP gossip (blocks/txs/sync) | `core-ts/p2p.ts` | `aegis serve` |
| **RPC** JSON-RPC 2.0 + REST + faucet/metrics | `core-ts/rpc.ts`, `GET /api/state`, `/metrics` | `POST /api/rpc` |
| **Explorer** живой, отдаётся узлом (KPI, sparkline, hybrid-verify, gov/bridge) | `explorer/index.html`, `docs/DESIGN.md` | `GET /` |
| **Keeper** конвертер без биржи (AMM x*y=k 0.3%) | `keeper/keeper.ts` | `npm run keeper` |
| **Контракты Base** ERC-20 + AMM + Staking + Governance + Multisig | `contracts/` | `forge create` |
| **Mobile Wallet** Passkey, Shamir 3-of-5 backup, QR, history, shield | `wallet-mobile/` | `npm run dev` |
| **CI/CD** GH Actions (slither, wallet), Docker hardened, keepalive | `.github/workflows/ci.yml`, `scripts/`, `Dockerfile` | — |

Документация: `docs/DESIGN.md`, `docs/SDK.md`, `docs/TUTORIAL.md`, `docs/TOKENOMICS.md`, `docs/ROADMAP.md`, `docs/API.md`, `docs/OPS.md`, `docs/THREAT_MODEL.md`, `docs/INFRA.md`, `docs/MESH.md`, `docs/MOBILE.md`, `ARCHITECTURE.md`

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
