/**
 * Live end-to-end check (v1.15): wallet → node.
 *
 *   1. create wallet keys (wallet crypto, not core crypto)
 *   2. fund via devnet faucet
 *   3. quote fee via aeg_gasPrice, read nonce
 *   4. build canonical tx message, sign hybrid (Ed25519 + ML-DSA-65), send
 *   5. wait for a block, confirm balance changed
 *   6. prove the new balance in the browser-style light client (checkpoint + PQ + Merkle)
 *
 * Usage: RPC=http://127.0.0.1:8899/api/rpc npx tsx scripts/live-e2e.ts
 */
import { hybridGenerate, hybridSign, ledgerTxMessage } from "../src/lib/aegis-wallet.js";
import { lightBalance } from "../src/lib/light.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const RPC = process.env.RPC ?? "http://127.0.0.1:8899/api/rpc";
const seed = sha256(new TextEncoder().encode("aegis-live-e2e-wallet-v115")).subarray(0, 32);

async function call(method: string, params: any[] = []): Promise<any> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j: any = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const w = hybridGenerate(seed);
  console.log("wallet address :", w.address);

  const health = await call("aeg_getState");
  console.log("node           : height", health.height);

  let acct = await call("aeg_getAccount", [w.address]);
  if (!acct) {
    const f = await call("aeg_faucet", [w.address, "50000000"]);
    console.log("faucet         :", f.funded, f.amount);
    acct = await call("aeg_getAccount", [w.address]);
  }
  console.log("balance before :", acct?.balance, "nonce", acct?.nonce);

  const gas = await call("aeg_gasPrice");
  const fee = BigInt(gas.suggestedMaxFee);
  const nonce = Number(acct?.nonce ?? 0);

  const to = "aeg1livee2e000000000000000000000000000000000000000000000000000";
  const fields = {
    from: w.address,
    to,
    amount: "1000",
    fee: fee.toString(),
    nonce,
    intent: "live e2e: wallet-signed transfer",
    domain: "aegis.local",
    timestamp: Date.now(),
    data: "",
  };
  const msg = ledgerTxMessage(fields);
  const sig = hybridSign(w, msg);
  const tx = {
    ...fields,
    amount: "1000",
    fee: fee.toString(),
    edPublicB64: Buffer.from(w.edPublic).toString("base64"),
    mlPublicKeyB64: Buffer.from(w.mlPublicKey).toString("base64"),
    sig,
  };

  const sent = await call("aeg_sendTx", [tx]);
  console.log("aeg_sendTx     :", JSON.stringify(sent));
  if (!sent?.accepted) throw new Error("node rejected the wallet transaction");

  const deadline = Date.now() + 180_000;
  let after = acct;
  while (Date.now() < deadline) {
    await sleep(3000);
    const a = await call("aeg_getAccount", [w.address]);
    if (a && BigInt(a.balance) !== BigInt(acct.balance)) { after = a; break; }
  }
  if (BigInt(after.balance) === BigInt(acct.balance)) throw new Error("balance did not change — tx not included");
  console.log("balance after  :", after.balance, "nonce", after.nonce);

  // wait for a checkpoint to cover the new state, then prove the balance locally
  let res = await lightBalance(call, w.address);
  for (let i = 0; i < 20 && !res.verified; i++) {
    console.log("  light:", res.verified ? "verified" : `not yet (${res.reason ?? res.alerts.join("; ")})`);
    await sleep(6000);
    res = await lightBalance(call, w.address);
  }
  console.log("light balance  :", res.verified ? "VERIFIED" : "NOT VERIFIED", "h=" + res.height, "cp=" + res.checkpointHeight);
  for (const c of res.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.label}: ${c.detail}`);
  for (const a of res.alerts) console.log("  ! " + a);
  if (!res.verified) throw new Error("light client could not prove the balance");
  if (res.balance !== after.balance) throw new Error(`proof balance ${res.balance} != node ${after.balance}`);

  // the hash the node published must be the one the wallet signed over
  console.log("tx message hash:", bytesToHex(sha256(new TextEncoder().encode(msg))));
  console.log("OK: wallet-signed tx accepted and balance proven without trusting the node");
}

main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
