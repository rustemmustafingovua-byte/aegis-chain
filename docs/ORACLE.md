# AEGIS Price Oracle (v1.11)

## Что
`contracts/AegisPriceOracle.sol` — TWAP over AMM reserves. Keeper calls `update()` per block, читатели — `twap(cumulativeOld, tsOld, windowSec)` + `spot()`.

## Зачем
- Bridge keeper нужен манипуляционно-стойкий price (spot легко дёрнуть MEV)
- TWAP 300s сглаживает sandwich-атаки на AMM

## Параметры
- Keeper interval: 1 блок (4s) или cron 30s
- Window: 300s (5 минут), stale check `dt >= window`

## Интеграция
```solidity
AegisPriceOracle oracle = AegisPriceOracle(0xORACLE);
uint256 twapPrice = oracle.twap(oldCumulative, oldTs, 300);
```

## Тесты
`contracts/test/Oracle.t.sol` — empty pool spot 0, no revert.
