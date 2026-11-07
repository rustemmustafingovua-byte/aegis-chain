# AEGIS Trust Mode Gate (v1.9, executable)

Fork в Trust Mode (real USDC + mainnet settlement) — только когда все gate PASS:

```bash
npx tsx cli/trustcheck.ts   # 10 gates: package, contracts 8+, SECURITY, RELEASE, THREAT_MODEL, foundry, gossipsub, WAL, explorer, wallet
npm test                    # 46 passing expected
npm run build
cd contracts && forge test  # 30 passing
cd wallet-mobile && npm run build  # PWA
curl :8899/health           # {"ok":true,"version":"x.y.z"}
```

External review required: Trail of Bits / Zellic sign-off на AEGIS.sol permit + BridgeVault.sol + AegisHTLC.sol. Без sign-off — testnet only.

## CI must show
- `npm test` green, `forge test` green, wallet build green, slither clean (или findings triaged в SECURITY.md)
- GitHub Release + GitHub Packages publish (см. docs/RELEASE.md, .github/workflows/release.yml)
