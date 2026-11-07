# AEGIS Tokenomics (v1.1, черновик — не финальный whitepaper)

## Supply
- **1e9 AEGIS** (1_000_000_000_000_000 base units, 6 decimals), hard cap mint 2e9 для инфляции сверх genesis только через Multisig+Governance
- **60%** казна (treasury, Multisig N-of-M, timelock), **40%** валидаторы (эмиссия по 3% APR, halving 4 года)
- Комиссии tx → proposer (не burn), 10% slash за equivocation/double-spend (escrow 180 дней для страхования жертв)

## Стейкинг
- MIN 10k AEGIS, unstake lock 100 блоков (~400s), награда 3% APR из эмиссии
- Слешинг за colluding agents (ровные временные паттерны скорингуются)

## AMM / Bridge
- AMM x·y=k, fee 30bps (0.30%), liquidity natively AEGIS/USDC на Base и в нативной цепи
- Bridge HTLC: USDC lock → AEGIS mint, timelock 60s..30d, multisig keeper, нет custody

## Anti-AI сборы
- Микро-комиссия в humanity-единицах (не токены) для Sybil-resistant лимитов
- Behavioral failures → review (70–40) или block (<40), guardians veto 60с

## Trust Mode
- До аудита и word-of-mouth: AEGIS не листится как спекулятивный актив, только trust-layer платежи
- После Trust Mode hard-fork: открытая торговля, казна идёт в LP + аудит-пул

*Не финансовая рекомендация. Токеномика — черновик для ревью комьюнити.*
