#!/usr/bin/env tsx
/**
 * AEGIS HTLC Watcher v1.9 — listens AegisHTLC.Funded (Base Sepolia) → claims on counterparty chain.
 * Mirror keeper/bridge-watcher.ts but for generic HTLC (Lumen ↔ AEGIS interchain).
 *
 * Env:
 *   AEGIS_HTLC_RPC=https://sepolia.base.org
 *   AEGIS_HTLC_ADDRESS=0x... (AegisHTLC.sol)
 *   AEGIS_RPC=http://localhost:8899/rpc
 *   AEGIS_HTLC_SECRET=hex32 (preimage to reveal on AEGIS chain claim)
 *
 * Flow: eth_getLogs(Funded) → decode → quote AEGIS AMM → claim tx on AEGIS (secret reveal)
 */
const HTLC_RPC = process.env.AEGIS_HTLC_RPC ?? "https://sepolia.base.org";
const HTLC_ADDR = process.env.AEGIS_HTLC_ADDRESS ?? "";
const RPC = process.env.AEGIS_RPC ?? "http://localhost:8899/api/rpc";
const SECRET = process.env.AEGIS_HTLC_SECRET ?? "";

async function ethRpc(method: string, params: any[] = []): Promise<any> {
  const res = await fetch(HTLC_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function tick(fromBlock: number) {
  if (!HTLC_ADDR) { console.warn("[htlc] AEGIS_HTLC_ADDRESS not set"); return fromBlock; }
  const toBlock = Number(await ethRpc("eth_blockNumber"));
  const logs = await ethRpc("eth_getLogs", [{ address: HTLC_ADDR, fromBlock: "0x" + fromBlock.toString(16), toBlock: "0x" + toBlock.toString(16), topics: undefined }]);
  for (const log of logs) {
    console.log(`[htlc] Funded log block=${Number(log.blockNumber)} tx=${log.transactionHash}`);
    // In prod: decode Funded(id,sender,amount,hash,timelock), reveal SECRET on counterparty,
    // verify AEGIS chain accepts, then claim on HTLC contract.
    if (SECRET) console.log(`[htlc] secret ready (len ${SECRET.length}) — would claim on counterparty`);
  }
  return toBlock + 1;
}

async function main() {
  let from = 0;
  console.log(`[htlc] watching ${HTLC_ADDR || "(unset)"} @ ${HTLC_RPC}`);
  while (true) {
    try { from = await tick(from); } catch (e: any) { console.error("[htlc] tick failed:", e.message); }
    await new Promise((r) => setTimeout(r, 10_000));
  }
}
await main();
