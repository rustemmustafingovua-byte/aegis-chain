# Passkey, TOFU и серверная проверка WebAuthn (v1.12)

## Что было не так до v1.12

1. **Passkey был декорацией.** Ключ шифрования кошелька выводился как
   `HMAC(rpName, credentialId)`. `credentialId` лежит в `localStorage` — дамп localStorage
   давал полный доступ к приватным ключам. Никакой hardware anchor.
2. **Аккаунты без ключа.** Если у аккаунта не был задан `edPublic`, `Ledger.apply()`
   пропускал проверку подписи. Кошелёк, получивший faucet, мог тратить **вообще без подписи**.
   Достаточно было любого `sig` правильной формы.

## Что сделано

### 1. TOFU key binding (first spend)

Адрес = `aeg1…` от Ed25519 pubkey. Первая трата с адреса обязана принести `edPublicB64`:

- `addressFromPublicKey(edPublicB64) === tx.from` — иначе отказ;
- гибридная подпись проверяется этим ключом;
- ключ и `sha256(ML-DSA pub)` записываются в аккаунт навсегда.

Подделать нельзя: чтобы связать чужой адрес, нужен ключ, хеш которого равен адресу.
После привязки все последующие транзакции проверяются только против сохранённого ключа.

### 2. WebAuthn PRF вместо HMAC-фальшивки

`wallet-mobile/src/lib/passkey.ts`:

- регистрация просит расширение `prf` (hmac-secret);
- `wrapKey = HKDF(prfOutput || localEntropy, salt="AEGIS/WRAP/1")`;
- `prfOutput` выдаёт аутентификатор **только после** user verification (Touch ID / Face ID / PIN);
- если PRF не поддерживается — кошелёк честно помечает `protection: "device"` и предупреждает
  в UI, а не делает вид, что это hardware anchor.

### 3. Серверная проверка церемоний

`core-ts/webauthn.ts` (~200 строк, без внешних зависимостей):

- **registration:** парсит `attestationObject` (CBOR) → `authData` → attested credential data →
  COSE public key (EC2 P-256 / OKP Ed25519); проверяет `clientDataJSON.type/challenge/origin`,
  `rpIdHash`, флаг UP/UV, совпадение `credentialId`.
- **assertion:** проверяет подпись над `authData || sha256(clientDataJSON)` (ES256 или EdDSA),
  challenge (для платежа — `sha256(txMessage)`), origin, rpId и счётчик подписи
  (монотонный; `0` = аутентификатор не считает, разрешено).

### 4. Гейт на транзакции

`aeg_sendTx` для аккаунта с привязанным passkey требует второй параметр — assertion:

```
params[1] = { credentialId, clientDataJSON, authenticatorData, signature }
```

Сервер:
1. находит binding по `credentialId` и сверяет адрес;
2. строит ожидаемый challenge `sha256(txMessage)`;
3. проверяет assertion;
4. обновляет счётчик.

Одинаковая assertion на другую транзакцию не пройдёт: challenge связан с точным сообщением.
Фишинговая страница не сможет подписать платёж, даже если получит assertion для «входа».

## RPC

| Метод | Параметры | Назначение |
|---|---|---|
| `aeg_passkeyRegister` | `[address, credId, clientDataJSON, attestationObject, hybridProof, mlPubB64, label?]` | привязать passkey (proof = гибридная подпись над `aegis-passkey-bind\|address\|credId`) |
| `aeg_passkeyInfo` | `[address]` | список credential'ов |
| `aeg_passkeyRevoke` | `[address, credId]` | отвязать |

Binding-и хранятся в `<stateFile>-passkeys.json` рядом со снапшотом цепи.

## Ограничения

- Attestation statement не валидируется (fmt `none` — норма для платформенных passkey).
  Доверие к вендору устройства — вне модели; проверяется владение ключом и свежесть.
- PRF поддерживается не везде (Safari 18+, Chrome 116+, Firefox — частично).
  Fallback — device-only, явно помечен.
- Счётчик подписи у платформенных passkey часто `0`; replay защищён challenge'ем (tx hash),
  а не счётчиком.
