# AEGIS Mesh Protocol — автономная p2p без интернета

## Принципы

1. **Никакого сервера.** Любой телефон = узел + кошелёк + relay.
2. **Store-carry-forward (DTN).** Пакет живёт у носителя, пока не встретит следующего.
3. **Epidemic gossip.** При встрече — обмен отсутствующими tx (Bloom-фильтр в проде).

## Пакет

```json
{
  "type": "AEGIS_PACKET",
  "v": "0.4",
  "tx": { "from": "aeg1...", "to": "aeg1...", "amount": "25", "nullifier": "hex", "sig": {...}, "txHash": "hex" },
  "hops": 0, "ttl": 8, "transport": "QR|BLE|WIFI_DIRECT|LORA|USB"
}
```

## Транспорты и лимиты

| Транспорт | Лимит | Фрагментация |
|---|---|---|
| QR | ~500B typed (сжато ~2KB) | один пакет, base64 |
| BLE | 185B | chunk + seq, TESLA-ключи |
| WiFi Direct | 64KB | raw JSON |
| LoRa | 51-242B | zlib + chunk, wake-on-mesh |
| USB sneakernet | ∞ | файл `.aegis-pkt.json` |

## Double-spend без интернета

- Каждый `nonce` рождает `nullifier = H(mlSeed || nonce)`. Два пакета с одним nullifier = конфликт.
- При синке: побеждает наименьший `txHash`. Проигравший — slashed в будущем (stake).
- Офлайн-лимит по умолчанию 100 AEGIS без онлайн-подтверждения.

## Анти-спам

- `human_context_hash` rate-limit: ≤ N операций/час на человека.
- Behavioral score <40 → дроп. Агент, который спамит, стоит дорого.

## Тесты

`test-ts/hybrid.test.ts` → Mesh offline gossip + double-spend detect.
