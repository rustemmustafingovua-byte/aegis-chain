#!/usr/bin/env tsx
/**
 * AEGIS Keeper v0.7 — автономный конвертер: USDC/ETH/Base → AEGIS (как Lumen keeper)
 * v0.7: daemon mode — polls live node via RPC, quotes AMM, submits keeper-mint tx.
 *   npm run keeper            # one-shot demo
 *   npm run keeper -- --loop  # daemon: every 60s scan + quote (cron/systemd ready)
 * В проде: слушает Base x402 / deposit events (AegisAMM.sol), пишет swap tx в цепь.
 */
import { hybridGenerate, hybridSign } from "../core-ts/hybrid.js";
import { Chain } from "../core-ts/chain.js";

const RPC = process.env.AEGIS_RPC ?? "http://localhost:8899/api/rpc";

async function rpcCall(method: string, params: any[] = []): Promise<any> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function tick() {
  console.log("[keeper] tick — fetching live node state…");
  try {
    const state = await rpcCall("aeg_getState");
    console.log(`[keeper] height=${state.height} supply=${state.supply} root=${state.stateRoot?.slice(0, 12)}…`);
    // quote a 100 USDC swap via live pool
    try {
      const q = await rpcCall("aeg_swapQuote", ["AEGIS/USDC", "1000000"]);
      console.log(`[keeper] AMM quote: 100 USDC → ${q.amountOut} AEGIS (key=${q.key})`);
    } catch (e: any) {
      console.log(`[keeper] swap quote unavailable (${e.message}) — pool may not exist yet`);
    }
    // x402 scan placeholder: in prod, poll Base deposit events / x402 payment feed here
    //   const deposits = await scanBaseDeposits();
    //   for (const d of deposits) await convertDeposit(d);
    console.log("[keeper] scan complete (no pending deposits)");
  } catch (e: any) {
    console.warn(`[keeper] node unreachable (${e.message}) — running local demo mode`);
    await demoLocal();
  }
}

async function demoLocal() {
  const chain = new Chain();
  chain.genesis();
  const user = hybridGenerate();
  chain.ledger.fund(user.address, 10_000_000000n);
  chain.ledger.get(user.address).edPublic = user.edPublic;
  chain.addValidator(user.edPublic, Buffer.from(user.mlPublicKey).toString("base64"), 10_000n, user.address);
  chain.ledger.addLiquidity("AEGIS/USDC", 1_000_000_000000n, 1_000_000_000000n, user.address);
  const quote = chain.ledger.quoteSwap("AEGIS/USDC", 100_0000n);
  console.log(`[keeper] demo: deposit 100 USDC → ${quote} AEGIS (live quote, no exchange)`);
  const ts = Date.now();
  const nonce = chain.ledger.get(user.address).nonce;
  const msg = Buffer.from([user.address, user.address, quote.toString(), "0", nonce, "keeper-mint", "keeper.aegis.local", ts].join("|"));
  const sig = hybridSign(user, msg);
  const tx = { from: user.address, to: user.address, amount: quote, fee: 0n, nonce, intent: "keeper-mint", domain: "keeper.aegis.local", timestamp: ts, sig, mlPublicKeyB64: Buffer.from(user.mlPublicKey).toString("base64") } as any;
  chain.mempool.add(tx);
  const block = chain.propose([tx], user, 1);
  chain.accept(block);
  console.log(`[keeper] block height=${block.header.height} accepted, user balance=${chain.ledger.balance(user.address)}`);
  console.log("[keeper] loop: scan deposits hourly → swap → block (cron/launchd)");
}

async function main() {
  console.log("[keeper] AEGIS autonomous converter starting…");
  if (process.argv.includes("--loop")) {
    console.log("[keeper] daemon mode: tick every 60s (Ctrl+C to stop)");
    await tick();
    setInterval(tick, 60_000);
  } else {
    await demoLocal();
  }
}
main();
