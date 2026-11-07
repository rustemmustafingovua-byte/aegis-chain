# AEGIS Security Policy — v1.2

## Threat model (anti-hacker + anti-AI-agent)

| Threat | Mitigation | Where |
|---|---|---|
| Quantum break of Ed25519 | Hybrid ML-DSA-65 (FIPS 204, Cat 3) — both sigs required | `core-ts/hybrid.ts` |
| Phishing / blind-sign by AI agent | Intent Binding: signed intent = recipient + amount + chain/domain; generic agents cannot reuse sig for another chain (domain binding) | `core-ts/aegis.ts` |
| Session hijack / replay | Ephemeral 60s liveness sessions, nullifier = H(key‖nonce), tx replays rejected | `core-ts/ledger.ts`, `core-ts/autonomy.ts` |
| Sybil validators / bot farm | Stake-weighted PoS + humanity quorum (behavioral score), MIN_STAKE 10k | `core-ts/chain.ts`, `core-ts/governance.ts` |
| Double-spend offline | Nullifier + lowest-tx_hash-wins conflict rule, CRDT/DAG merge for mesh | `core-ts/mesh.ts` |
| P2P eclipse / DoS | HELLO auth (Ed25519), peer scoring + ban at −100, 50 msg/s rate limit, 256KB cap, sync cap 100 blocks | `core-ts/p2p.ts`, `core-ts/libp2p.ts` |
| Bridge theft | HTLC (hash-time-lock), watcher mints only on `Funded` event, no custodian key | `core-ts/bridge.ts`, `contracts/BridgeVault.sol` |
| Key exfil via malware | Passkey unwrap: AES-GCM key = HKDF(passkey_sig ‖ local_entropy) — no raw seed on disk | `wallet-mobile/src/lib/passkey.ts` |
| Reentrancy / MEV (AMM/vault) | NonReentrant + CEI + `swap(minOut,deadline)` + timelock bounds 60s..30d + sender-only refund | `contracts/AegisAMM.sol`, `contracts/BridgeVault.sol` |
| Supply inflation | `AEGIS.sol` MINT_CAP 2e9, onlyOwner, Mint event | `contracts/AEGIS.sol` |
| RPC DoS / oversized tx | Body cap 1MB (413), hybrid size guards 64B/3309B/1952B, ledger canApply dry-run | `core-ts/rpc.ts`, `core-ts/hybrid.ts`, `core-ts/ledger.ts` |
| Liveness forgery | Liveness response binds `challenge‖humanContextHash`; tamper fails verifyIntent | `core-ts/aegis.ts`, `test-ts/security.test.ts` |

## Audit checklist — before Trust Mode fork / mainnet

- [ ] **Slither** on `contracts/*.sol` — expect 0 high/medium (permit, AMM math, vault `onlyOwner`).
  `slither .` — record output in CI artifact.
- [x] **VM resolution**: foundry sequence tests in `Invariants.t.sol` for conservation + k-monotonic + MINT_CAP.
  `forge test` (10 passed). Stateful fuzz handler — add forge-std before mainnet.
- [x] **Hybrid sig fuzz**: `hybridVerify` with truncated ML-DSA sig must return false (not throw 500). Covered by `test-ts/security.test.ts` + size guards in `hybrid.ts`.
- [ ] **Nullifier edge**: same nullifier from two mesh carriers → second rejected, no double-apply. Covered by `test-ts/v07.test.ts`.
- [ ] **External review**: Trail of Bits / Zellic / Zellic-equivalent sign-off on `AEGIS.sol` permit + `BridgeVault.sol` before real USDC.
  Testnet (Base Sepolia) is the pre-review sandbox — do not accept mainnet USDC until review lands.
- [ ] **Passkey phishing**: WebAuthn RP ID binding — wallet must refuse `rpId != aegis.chain` signatures. Verified in `wallet-mobile/src/lib/passkey.ts`.

## Disclosure

Report issues privately: <SECURITY@rustemmustafingovua-byte.github.io> (open GitHub Security Advisory).
Payout: GitHub Sponsors / USDC bounty per `STRATEGY.md` — no testnet airdrop promises.

## Trust Mode fork gate

Fork to `Trust Mode` (real USDC bridge + mainnet settlement) only when all boxes above are checked
and CI shows: `npm test` green, `forge test` green, `slither` clean, and at least one external review signed off.
Until then: testnet only, `USDC_ADDRESS` = Sepolia mock, no mainnet custody.
