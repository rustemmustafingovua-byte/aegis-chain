# AEGIS Governance + Staking + Slash (v0.6)

## Staking (PoS)

- MIN_STAKE = 10_000 AEGIS. Tx `data: stake:` / `unstake:`.
- Валидатор продюсирует блоки пропорционально stake (`proposerForSlot`).
- Награда 3% годовых (как Lumen), в проде через `rewardProposer`.

## Slash против colluding agents

- Эквивокация, double-spend, поддельный governance-vote → `data: slash:<addr>` или авто при конфликте nullifier.
- Слэш 10% (1000 bps). Средства — в страхование жертв (escrow 180 дней).

## AMM в цепи

- `addLiquidity / removeLiquidity / swap / quoteSwap` — как Lumen AMM.
- LP shares: пул → владелец. Чужие доли вывести нельзя.
- Пул `AEGIS/USDC` — живой курс для Keeper и Bridge.

## Governance (anti-Sybil)

- Голос = **вес stake**. Один адрес = один голос (Sybil defense).
- Проход: **≥2/3 stake for** + **≥2 humanity-votes** (score ≥70).
- Humanity ticket берётся из behavioral scoring (Anti-AI Shield).

## Bridge Base ↔ AEGIS (HTLC)

- `fund() → hashlock=sha256(secret)`, `claim(secret)` на другой стороне.
- `quoteBaseToAegis(usdcIn, ammBase, ammQuote)` — курс без биржи.
- Timelock 3600с, refund после expiry.

## Discovery (Kademlia-lite)

- Bootstrap список по умолчанию. `ping` TCP probe, `exchange` peer lists, `closest(nodeId)` по XOR-дистанции.
