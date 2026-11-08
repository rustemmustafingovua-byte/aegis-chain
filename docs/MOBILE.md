# AEGIS Mobile Wallet — Passkey + trustless balance (v1.15)

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

## Проверка баланса без доверия узлу (v1.15)

Кнопка **«✓ проверить без доверия (checkpoint + PQ)»** прогоняет в браузере
(`src/lib/light.ts`):

1. `aeg_validatorSet` → ключи валидаторов (Ed25519 + ML-DSA-65, стейк);
2. `aeg_checkpointLatest` → подписи проверяются **локально**, порог ≥2/3 стейка;
3. `aeg_getHeaders(cp.height+1 … head)` → h/prevHash/хеш, гибридная подпись блока, VRF;
4. `aeg_getProof(addr)` → Merkle-путь, `root === cp.stateRoot`, разбор листа аккаунта.

Если состояние ушло вперёд checkpoint'а (root не совпал), кошелёк пишет
«баланс не подтверждён», а не показывает «наверное, верный». ML-DSA-65
проверяется в самом кошельке (`@noble/post-quantum`), не узлом.

Совместимость с ядром закреплена тестами (`test/compat.test.ts`,
`test/light.test.ts`): `hybrid = sha256(base64(edSig) ‖ base64(mlSig))`,
каноничное сообщение транзакции совпадает с `core-ts/ledger.ts`, подделка
поля `hybrid` отклоняется. `src/lib/noble-setup.ts` обязан импортироваться до
любого использования `@noble/ed25519` (v2 требует `ed.etc.sha512Sync`).

```bash
cd wallet-mobile
npm test        # 8 тестов: совместимость с ядром + light client
npm run test:live   # живой e2e: faucet → tx из кошелька → proof баланса (нужен узел на :8899)
npm run build
```

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
