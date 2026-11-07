# AEGIS BLE Mesh (v1.3, браузер)

## Что
MeshPacket JSON чанкуется base64 → Web Bluetooth GATT (SERVICE `0000a1a1-…`), max 512B chunks.
- **Central (скан):** `bleScanAndRead()` — requestDevice с фильтром сервиса, readValue loop до `}`
- **Peripheral (реклама):** в проде — нативный BLE server (Expo), в браузере — notify characteristic
- **iOS Safari:** Web Bluetooth недоступен → fallback QR (уже есть)

## Файл
`wallet-mobile/src/lib/ble.ts` — `bleEncode/bleDecode/bleSupported/bleScanAndRead`

## Использование (кошелёк)
Пока: QR как основной офлайн-транспорт, BLE — для Android/Chrome mesh тестов.
Интеграция в UI — v1.4 (кнопка Scan BLE в Платёж tab рядом с QR scan).

See also: `docs/MESH.md` (QR/BLE/LoRa/USB transports), `docs/MOBILE.md` (Expo BLE roadmap).
