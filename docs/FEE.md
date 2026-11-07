# AEGIS Fee Market (v1.12)

## Зачем

Фиксированные 1000 base units за транзакцию — это:
- бесплатный вектор спама (агент может забить мемпул за секунды),
- отсутствие ценового сигнала для кошелька,
- невозможность приоритезации при перегрузке.

AEGIS использует **EIP-1559-lite**: плавающий base fee, который двигается от загрузки блоков.

## Правила

| Параметр | Значение |
|---|---|
| Стартовый base fee | `1000` base units (= `TX_FEE`) |
| Пол | `1` |
| Потолок | `1e9` base units (1000 AEGIS) |
| Цель блока | `MAX_BLOCK_TXS / 2` = 250 tx |
| Макс. изменение за блок | ±12.5% |
| Приоритет (tip) для кошелька | `1000` (suggested max fee = base + tip) |

```
txCount > target → baseFee += baseFee * (txCount-target)/target / 8
txCount < target → baseFee -= baseFee * (target-txCount)/target / 8
```

Пустые блоки (devnet) быстро опускают base fee к полу, полные — поднимают.

## Где живёт

- `core-ts/fee.ts` — `FeeMarket` (update/suggest/accepts/median/history).
- `Chain.accept()` вызывает `feeMarket.update(txCount, MAX_BLOCK_TXS, height)` после каждого блока.
- Снапшот цепи сохраняет `baseFee` и историю (`Chain.serialize` / `deserialize`).

## Политика, не консенсус

Base fee **не входит** в валидацию блоков: старые блоки и сторонние ноды с другой политикой остаются валидными. Это mempool/enterprise-политика на входе:

- `aeg_sendTx` отклоняет `fee < baseFee` с подсказкой использовать `aeg_gasPrice`.
- Кошелёк обязан цитировать `aeg_gasPrice` (mobile wallet v1.12 так и делает).

Такое разделение позволяет ужесточать политику без хардфорка и без риска раскола сети.

## RPC

| Метод | Ответ |
|---|---|
| `aeg_gasPrice` | `{ baseFee, priorityFee, suggestedMaxFee, median }` |
| `aeg_feeHistory [n]` | последние `n` сэмплов `{ height, baseFee, txCount, utilization }` |
| `/api/state` | `baseFee`, `suggestedFee` для explorer |

## Burn (опционально)

`AEGIS_BURN_FEE=on` зарезервировано под дефляционный профиль: базовая часть комиссии сжигается, tip идёт продюсеру. По умолчанию продюсер получает всю комиссию (v0.7 экономика).
