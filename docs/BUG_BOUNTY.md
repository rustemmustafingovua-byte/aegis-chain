# AEGIS Bug Bounty (v1.2, черновик bounty terms)

## Scope
- `core-ts/` (chain, ledger, hybrid, aegis shield, p2p/libp2p, rpc, governance, bridge, mesh)
- `contracts/` (AEGIS, AegisAMM, BridgeVault, AegisStaking, AegisGovernance, AegisMultisig)
- `wallet-mobile/` (Passkey unwrap, shamir backup, intent signing)
- **Out of scope:** соц-инженерия вне протокола, физический доступ к устройству, testnet faucet abuse

## Severity
| Sev | Пример | Награда (черновик) |
|---|---|---|
| Critical | Подпись без приватника, вывод средств минуя hybrid, infinite mint | USDC bounty + GitHub Sponsors, по договорённости |
| High | Domain binding bypass, nullifier replay, vault claim без секрета | аналогично |
| Medium | DoS mempool/P2P, slash bypass | + credit в CONTRIBUTORS |
| Low | UX фишинг-паттерн, info leak | gratitude + patch credit |

## Rules
- Не тестируй mainnet, чужие кошельки, не пашь данные. Только testnet Sepolia.
- Responsible disclosure: GitHub Security Advisory, 90 дней до публичности.
- Награда не гарантируется для дублей/낙руток; final — по `SECURITY.md` Trust Mode gate.
