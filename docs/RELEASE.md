# AEGIS Release & Testnet (v1.6)

## NPM publish (после `npm login`)
```bash
npm publish --registry=https://npm.pkg.github.com  # GitHub Packages, без npm login
# или tarball из релиза:
npm i -g https://github.com/rustemmustafingovua-byte/aegis-chain/releases/download/v1.6.0/aegis-chain-1.6.0.tgz
```

## GitHub Release
```bash
gh release create v1.6.0 --title "AEGIS v1.6" --notes "see README changelog"
# + attach dist/ tarball + deployments/aegis-sepolia.log
```

## Testnet Sepolia E2E
```bash
cp .env.example .env   # burner PRIVATE_KEY
bash scripts/deploy-all.sh
# AEGIS → AMM → Vault → Staking → Governance → Multisig → Timelock → Paymaster → Faucet → Vesting → Airdrop
# seed AMM pool, faucet drip, keeper:bridge live
```

## Audit prep
- `slither .` (CI уже гоняет), `forge coverage`
- External review: Trail of Bits / Zellic sign-off перед Trust Mode (см. SECURITY.md)
