# AEGIS Tutorial (v1.1) — от ноды до офлайн-платежа

## 1. Запустить ноду

```bash
cd ~/workspace/workspace/aegis-chain
npm ci && npm run build
npm run serve -- --port=8899
curl http://127.0.0.1:8899/health   # {"ok":true,"version":"1.1.0"}
curl http://127.0.0.1:8899/metrics  # aegis_height, supply …
```

## 2. Faucet (devnet)

```bash
curl -X POST http://127.0.0.1:8899/rpc -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"aeg_faucet","params":["aeg1YOURADDR","10000000000"]}'
# 10k AEGIS на адрес, лимит 5/request-rate
```

## 3. Кошелёк

```bash
cd wallet-mobile && npm i && npm run dev   # http://localhost:5188
# Создай Passkey, разблокируй, укажи RPC http://127.0.0.1:8899/rpc
# Подпиши платёж → behavioral score → отправь в сеть
```

## 4. Офлайн mesh

- Подпиши офлайн (QR/BLE), перенеси пакет, нода с mesh синканит по nullifier
- Double-spend второй пакет отклонится (lowest-tx_hash-wins)

## 5. Деплой на Sepolia

```bash
cp .env.example .env   # burner PRIVATE_KEY
bash scripts/deploy-all.sh
# AEGIS → AMM → Vault → Staking → Governance → Multisig
forge test   # 16 passing (AMM CEI, staking lock, gov humanity, multisig, invariants)
```

## 6. Governance

```bash
# создать + голосовать через explorer Governance tab или RPC
# aeg_govPropose [id,title,action,proposer]
# aeg_govVote [id,voter,support] → tally: >=2/3 stake + humanity >=2
```
