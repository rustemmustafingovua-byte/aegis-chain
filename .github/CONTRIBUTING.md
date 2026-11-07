# Contributing to AEGIS

## Quick start
```bash
npm ci && npm test        # 40 passing
npm run build
cd contracts && forge test  # 16 passing
cd wallet-mobile && npm run build
```

## Conventions
- TypeScript ESM (`core-ts/*.ts` → `dist/`), Solidity 0.8.20, British RU docs + EN code comments
- Hybrid sig required for every tx/block change; add tamper tests in `test-ts/security.test.ts`
- Contracts: CEI + nonReentrant + events; add forge test for every external fn
- Commits: `vX.Y: <что>`; push to `main` triggers CI (ts + python + forge + wallet + slither)

## Security
Не коммити `.env`, приватные ключи, `deployments/*.json`. Находки — `docs/BUG_BOUNTY.md`.
