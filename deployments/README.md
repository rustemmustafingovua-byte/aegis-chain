# AEGIS Deployments (Base)

Контракты для Base (как Lumen contracts/LMN.sol + LumenAMM.sol):

```bash
cd contracts
forge create --rpc-url $BASE_RPC --private-key $PK AEGIS.sol:AEGIS
forge create --rpc-url $BASE_RPC --private-key $PK AegisAMM.sol:AegisAMM
# адреса сохранить сюда как deployments/aegis-base.json
```

Цели: мост Base ↔ AEGIS Chain (HTLC-свопы, v0.3 roadmap), keeper конвертит USDC → AEGIS через AMM.
