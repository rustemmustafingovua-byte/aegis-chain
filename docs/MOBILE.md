# AEGIS Mobile Wallet — Passkey Morgan (v0.5)

## Стек

- Vite + React PWA (`wallet-mobile/`), `@simplewebauthn/browser`, `@noble/post-quantum`, `@noble/ed25519`.
- Работает на iPhone/Android через Safari/Chrome, WebAuthn = Touch ID / Face ID / Windows Hello.

## Архитектура

```
Passkey (FIDO2, hardware)
   │  credentialId + userHandle
   ▼
unwrapKey = HKDF(passkey_sig || local_entropy)
   │
   ▼
AES-GCM(seed_ed || seed_ml) → localStorage ciphertext
```

- Приватные ключи **никогда не покидают** устройство в открытом виде.
- Сессия — эфемерный ключ 60 секунд, потом wipe из памяти.
- EdDSA (COSE -8) → напрямую в Passkey на Android; на старых — ES256 + unwrap.

## UX против фишинга

1. Intent-экран показывает **полный рендер** (to, amount, intent на человеческом, domain) на железе.
2. Подпись привязана к домену: чужой домен = невалидна.
3. Liveness challenge каждые 30с: `H(last_block || window) + local_entropy`.
4. Behavioral: интервалы нажатий + confirmMs. Агент = score <40 = блок.

## Запуск

```bash
cd wallet-mobile
npm install
npm run dev    # → http://localhost:5188 (нужен HTTPS для Passkey на телефоне)
npm run build  # → dist/ (статика для любого хостинга)
```

## Дальше (v0.6+)

- React Native (Expo): тот же `lib/aegis-wallet.ts`, но `expo-passkey` + Secure Enclave.
- QR mesh: `qrcode` + `html5-qrcode` scan → offlinePacket разбор.
- Push mesh: BLE через Web Bluetooth (Chrome Android) + WiFi Direct.
