# AEGIS TypeScript SDK (v1.1)

```ts
import { createRpcServer, Chain, Ledger } from "aegis-chain";
import { hybridGenerate, hybridSign } from "aegis-chain/hybrid";
import { signIntent, verifyIntent } from "aegis-chain/aegis";
```

## Ключи и подпись

```ts
import { randomBytes } from "node:crypto";
const kp = hybridGenerate(randomBytes(32));
const sig = hybridSign(kp, "canonical-intent");
const ok = hybridVerify(kp.edPublic, kp.mlPublicKey, "canonical-intent", sig);
```

## Intent (Anti-AI)

```ts
const tx = signIntent(kp, { from: kp.address, to: "aeg1…", amount: "1000000", intent: "sale #1", domain: "shop.aegis.local", expiry: 60 }, Buffer.alloc(16), "genesis");
const v = verifyIntent(kp.edPublic, kp.mlPublicKey, tx); // {ok, reason}
```

## Ledger / Chain

```ts
const ledger = new Ledger();
ledger.fund(addr, 1_000_000_000_000n); // devnet faucet equivalent
const chain = new Chain();
chain.ledger = ledger;
// RPC: aeg_faucet [addr, amount], aeg_sendTx [tx], aeg_registerValidator [edPub, mlPubB64, stake, addr]
```

## RPC

```ts
const r = await fetch("http://127.0.0.1:8899/rpc", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "aeg_faucet", params: ["aeg1…", "1000000"] }) });
const j = await r.json(); // {result:{funded, amount, balance}}
```

Метрики: `GET /metrics` (Prometheus text), `aeg_metrics` (JSON).
