# AEGIS Threat Model (v1.0)

## Активы
- Приватные ключи: Ed25519 + ML-DSA-65 seed (в железе Passkey, RMS unwrap)
- Средства: AEGIS native + ERC-20 BridgeVault/Base AMM
- Целостность: chain state, mempool, governance proposals

## Adversary classes

| Adversary | Способ | AEGIS-митигация |
|---|---|---|
| Фишер | Fake front-end, подмена адреса | Intent Binding + Domain Binding + intent на экране (железо) |
| AI-агент draining | Prompt-injection, автономный 0-day | Semantic Firewall (untrusted_text), behavioral scoring, rate-limit по human_context_hash, time-lock+veto 60с |
| Квантовый harvest-now | Сбор подписей | Hybrid Ed25519+ML-DSA-65 (сломать оба), ML-DSA 1952B ключи |
| Sybil валидаторов | 10k агентов голосуют | Stake 10k + humanity quorum ≥2, slash 10% |
| Double-spend offline | Два carrier одного nullifier | Nullifier H(key‖nonce), lowest-tx_hash-wins, CRDT merge |
| Eclipse / DoS P2P | Eclipse, flood | HELLO auth Ed25519, scoring −100 ban, 50 msg/s, 256KB cap, sync 100 |
| Bridge theft | Поддельный Funded | HTLC hashlock, watcher mints только на Funded event, timelock 60s..30d, keeper без custody |
| Reentrancy / MEV | AMM re-enter, sandwich | NonReentrant + CEI + swap(minOut,deadline), k monotonic |
| Passkey phishing | rpId подмена | WebAuthn RP ID binding `aegis.chain`, wallet отказывается от чужих rpId |
| Supply inflation | Infinite mint | AEGIS.sol MINT_CAP 2e9, onlyOwner, mint event |

## Trust Mode gate
Fork на real USDC/mainnet только при: forge green (10), npm green (35), slither clean, invariants conservation + k-monotonic, external review signed, Passkey rpId audit. Иначе — testnet only (см. SECURITY.md).

## Не покрываем
- Пользователь сам подтверждает фишинг своим железом (intent UI — последняя миля)
- Браузерный malware, читающий экран/печатает за пользователя (нужен hardened UI/внешний экран)
- DDoS L7 gateway (за нами rate-limit RPC 1MB, P2P scoring; внешний WAF — за оператором)
