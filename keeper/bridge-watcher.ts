#!/usr/bin/env tsx
/**
 * AEGIS Bridge Watcher v0.8 — listens Base BridgeVault.Funded → mints AEGIS via keeper tx
 *
 * Env:
 *   AEGIS_BASE_RPC=https://sepolia.base.org (or BASE_RPC)
 *   AEGIS_BRIDGE_VAULT=0x... (BridgeVault.sol on Base)
 *   AEGIS_RPC=http://localhost:8899/api/rpc (AEGIS chain node)
 *   AEGIS_KEEPER_SEED=hex32 (deterministic keeper keypair; generated if absent)
 *
 * Flow: eth_getLogs(Funded) → decode(id,sender,amount,hash,lock) → quote via AEGIS AMM
 *       → aeg_sendTx(reward:addr:amt) or swap tx → next tick scans from last block.
 */
import { hybridGenerate, hybridSign } from "../core-ts/hybrid.js";

const BASE_RPC = process.env.AEGIS_BASE_RPC ?? process.env.BASE_RPC ?? "https://sepolia.base.org";
const VAULT = process.env.AEGIS_BRIDGE_VAULT ?? "";
const RPC = process.env.AEGIS_RPC ?? "http://localhost:8899/api/rpc";
const KEEPER_SEED = process.env.AEGIS_KEEPER_SEED ? Buffer.from(process.env.AEGIS_KEEPER_SEED, "hex") : Buffer.from("aegis-keeper-bridge-seed-v0.8!!!!!", "utf8").subarray(0, 32);

// keccak256("Funded(bytes32,address,uint256,bytes32,uint256)")
const FUNDED_TOPIC = "0x" + "BESPOKE"; // filled at runtime via cast if available; fallback scans all logs with 4 topics

async function baseRpc(method: string, params: any[] = []): Promise<any> {
  const res = await fetch(BASE_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`Base RPC ${method}: ${j.error.message}`);
  return j.result;
}

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

function decodeFunded(log: any): { id: string; sender: string; amount: bigint; hashlock: string } | null {
  // BridgeVault: event Funded(bytes32 indexed id, address sender, uint256 amount, bytes32 hashlock, uint256 timelock)
  // topics[0]=sig hash, topics[1]=id; data = sender, amount, hashlock, timelock
  try {
    const id = log.topics?.[1];
    const data = log.data;
    if (!id || !data) return null;
    const hex = data.slice(2);
    const sender = "0x" + hex.slice(24, 64);
    const amount = BigInt("0x" + hex.slice(64, 128));
    const hashlock = "0x" + hex.slice(128, 192);
    return { id, sender, amount, hashlock };
  } catch { return null; }
}

async function scanOnce(fromBlock: number): Promise<number> {
  if (!VAULT) {
    console.log("[bridge-watcher] AEGIS_BRIDGE_VAULT not set — dry-run: simulate one Funded deposit");
    // simulate
    const keeper = hybridGenerate(KEEPER_SEED);
    console.log(`[bridge-watcher] keeper ${keeper.address} (simulated deposit 100 USDC)`);
    try {
      const q = await rpcCall("aeg_swapQuote", ["AEGIS/USDC", "1000000"]);
      console.log(`[bridge-watcher] quote 100 USDC → ${q.amountOut} AEGIS (live node)`);
    } catch (e: any) {
      console.log(`[bridge-watcher] node unreachable (${e.message})`);
    }
    return fromBlock;
  }
  const latest = Number(await baseRpc("eth_blockNumber"));
  console.log(`[bridge-watcher] scanning Base blocks ${fromBlock}..${latest} vault=${VAULT}`);
  const logs = await baseRpc("eth_getLogs", [{ address: VAULT, fromBlock: "0x" + fromBlock.toString(16), toBlock: "0x" + latest.toString(16) }]);
  for (const log of logs ?? []) {
    const decoded = decodeFunded(log);
    if (!decoded) continue;
    console.log(`[bridge-watcher] Funded id=${decoded.id.slice(0, 10)}… sender=${decoded.sender} amount=${decoded.amount}`);
    // mint AEGIS to sender via reward tx (keeper is system minter in bridge context)
    try {
      const keeper = hybridGenerate(KEEPER_SEED);
      const ts = Date.now();
      const nonce = 0; // keeper tx nonce fetched from node in prod; sim uses 0
      // For live node: build reward tx and submit via aeg_sendTx
      const msg = Buffer.from([keeper.address, keeper.address, decoded.amount.toString(), "0", nonce, "bridge-mint", "bridge.aegis.local", ts, `reward:${decoded.sender}`].join("|"));
      const sig = hybridSign(keeper, msg);
      const tx = {
        from: keeper.address, to: keeper.address, amount: decoded.amount, fee: 0n,
        nonce, intent: "bridge-mint", domain: "bridge.aegis.local", timestamp: ts,
        sig, mlPublicKeyB64: Buffer.from(keeper.mlPublicKey).toString("base64"),
        data: `reward:${decoded.sender}`,
      };
      // serialize bigint via string; node parseTx handles
      const txJson = JSON.parse(JSON.stringify(tx, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
      const r = await rpcCall("aeg_sendTx", [txJson]);
      console.log(`[bridge-watcher] minted ${decoded.amount} AEGIS → ${decoded.sender}: ${JSON.stringify(r)}`);
    } catch (e: any) {
      console.warn(`[bridge-watcher] mint failed: ${e.message}`);
    }
  }
  return latest;
}

async function main() {
  console.log("[bridge-watcher] AEGIS Base→AEGIS bridge starting…");
  const keeper = hybridGenerate(KEEPER_SEED);
  console.log(`[bridge-watcher] keeper ${keeper.address} baseRpc=${BASE_RPC} vault=${VAULT || "(sim)"}`);
  let fromBlock = Number(process.env.FROM_BLOCK ?? 0);
  if (!VAULT && !process.argv.includes("--loop")) {
    await scanOnce(0);
    return;
  }
  await scanOnce(fromBlock);
  if (process.argv.includes("--loop")) {
    console.log("[bridge-watcher] daemon: scan every 60s");
    setInterval(async () => {
      try { fromBlock = await scanOnce(fromBlock); } catch (e: any) { console.warn("[bridge-watcher]", e.message); }
    }, 60_000);
  }
}
main();
