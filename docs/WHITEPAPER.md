# AEGIS Whitepaper — краткая версия (v1.2, черновик)

**Тезис:** классическая крипта защищает ключи, но ИИ-агенты атакуют намерение. AEGIS защищает intent живого человека.

## 1. Угроза 2026
Агенты генерируют фишинг массами, ищут 0-day ночью, обходят капчи, делают social-engineering точнее человека. Кошельки защищают сиды, но не *зачем* подписано.

## 2. Принципы
1. **Hybrid PQ-first:** Ed25519 + ML-DSA-65 (FIPS 204 Cat 3), сломать надо оба.
2. **Аппаратный якорь:** Passkey/FIDO2, ключ не извлекаем, эфемерные 60с сессии.
3. **Intent Binding:** `Sign(from|to|amount|intent|domain|expiry|humanContextHash|nonce)` — подмена области = подпись не сойдётся.
4. **Liveness:** `H(blockHash‖30s window)` → ответ `Sign(challenge‖humanContextHash)` — энтропия сенсоров.
5. **Behavioral economics:** скоринг интервалов/реакций делает атаку дорогой, а не невозможной.
6. **Offline DTN:** nullifier `H(key‖nonce)`, lowest-tx_hash-wins, CRDT merge, mesh QR/BLE/LoRa/USB.
7. **Bridge без кастодиана:** HTLC USDC → AEGIS, таймлоки, multisig keeper.

## 3. Архитектура
PoS 2/3 + VRF `H(slot‖head)`, AMM 0.30%, стейкинг 10k/100 блоков, governance stake+humanity ≥2, dual transport P2P (TCP-lite + libp2p Noise/gossipsub), RPC JSON-RPC, explorer, keeper.

## 4. Токеномика
1e9 AEGIS, 60% казна / 40% валидаторы, 3% APR halving 4 года, slash 10% escrow. Не спекуляция — trust layer (см. TOKENOMICS.md).

## 5. Ограничения
Ложные срабатывания behavioral, PQ ключи большие (1952B), hardened UI нужен внешне. Если человек сам подтверждает фишинг железом — протокол честно предупреждает, но не блокирует (свобода воли).

*Полный PDF/аудит — после external review. Не финансовая рекомендация.*
