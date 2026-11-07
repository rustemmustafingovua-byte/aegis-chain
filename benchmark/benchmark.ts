#!/usr/bin/env tsx
/**
 * AEGIS Benchmark v1.10 — TPS measurements (hybrid, ledger, mempool)
 * Usage: npx tsx benchmark/benchmark.ts
 */
import { randomBytes } from "node:crypto";
import { hybridGenerate, hybridSign, hybridVerify } from "../core-ts/hybrid.js";
import { Ledger } from "../core-ts/ledger.js";

function timeit(label: string, n: number, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < n; i++) fn();
  const ms = performance.now() - start;
  console.log(`${label}: ${n} ops in ${ms.toFixed(1)}ms → ${(n / (ms / 1000)).toFixed(1)} ops/s`);
  return n / (ms / 1000);
}

const kp = hybridGenerate(randomBytes(32));
const sig = hybridSign(kp, "benchmark payload");
timeit("hybridSign (ed+ml-dsa)", 100, () => hybridSign(kp, "benchmark payload"));
timeit("hybridVerify (ed+ml-dsa)", 100, () => hybridVerify(kp.edPublic, kp.mlPublicKey, "benchmark payload", sig));

const l = new Ledger();
const a = hybridGenerate(randomBytes(32));
l.fund(a.address, 10_000_000_000000n);
l.get(a.address).edPublic = a.edPublic;
// pre-sign one tx template (reuse with nonce increment via apply path is stateful — measure canApply)
timeit("ledger.canApply", 200, () => {
  const base: any = { from: a.address, to: "aeg1bob", amount: 1000n, fee: 1000n, nonce: l.get(a.address).nonce, intent: "bench", domain: "bench.aegis.local", timestamp: Date.now(), sig: hybridSign(a, "x"), mlPublicKeyB64: Buffer.from(a.mlPublicKey).toString("base64"), data: "" };
  base.sig = hybridSign(a, l.txMessage(base));
  try { l.canApply(base); } catch {}
});
console.log("done");
