#!/usr/bin/env tsx
/**
 * AEGIS CLI — wallet new / send / mesh / demo / bench / serve
 */
import { createHash, randomBytes } from "node:crypto";
import { hybridGenerate, hybridSign } from "../core-ts/hybrid.js";
import { signIntent, verifyIntent, behavioralScore } from "../core-ts/aegis.js";
import { MeshNode, makePacket } from "../core-ts/mesh.js";
import { Chain } from "../core-ts/chain.js";
import { Ledger } from "../core-ts/ledger.js";

function banner(t: string) { console.log(`\n${"=".repeat(60)}\n${t}\n${"=".repeat(60)}`); }

async function demo() {
  banner("AEGIS TS — Hybrid Ed25519 + ML-DSA-65 (Dilithium3)");
  const alice = hybridGenerate();
  const bob = hybridGenerate();
  console.log(`Alice ${alice.address}`);
  console.log(`Bob    ${bob.address}`);
  console.log(`ML-DSA sizes: pk 1952B, sig 3309B (FIPS 204)`);

  banner("1) Intent-bound payment (online)");
  const ent = randomBytes(16);
  const tx = signIntent(alice, { from: alice.address, to: bob.address, amount: 10n, intent: "продажа велосипеда #4721", domain: "marketplace.aegis.example", expiry: Math.floor(Date.now()/1000)+120 }, ent, "genesis1234");
  const v = verifyIntent(alice.edPublic, alice.mlPublicKey, tx);
  console.log(`Submitted tx sig hybrid=${tx.sig.hybrid.slice(0,16)}... verify=${v.ok} ${v.reason}`);
  const behav = behavioralScore([420,890,310,1200,650], tx.humanContextHash, 3800);
  console.log(`Behavioral score=${behav.score} (${behav.verdict}) flags=${behav.flags.join(", ")}`);

  banner("2) Mesh offline: Alice offline -> Bob via QR/BLE");
  const nA = new MeshNode("A", alice);
  const nB = new MeshNode("B", bob);
  nA.connect(nB);
  const offlineTx = nA.signOffline(bob.address, 25n, "offline оплата QR", "mesh.aegis.local", randomBytes(16));
  console.log(`Offline txHash=${offlineTx.txHash.slice(0,16)}... nullifier=${offlineTx.nullifier.slice(0,12)}...`);
  const pkt = makePacket(offlineTx, "QR");
  console.log(`QR packet size=${Buffer.byteLength(JSON.stringify(pkt, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))}B (QR capacity ~500B typed, DHilbert compressed in prod)`);
  const nodes: Record<string, MeshNode> = { A: nA, B: nB };
  nA.gossip(nodes);
  console.log(`Bob received? mempool size=${nB.mempool.size} status ok`);

  banner("3) Chain: PoS + hybrid blocks");
  const chain = new Chain();
  chain.genesis();
  chain.ledger.fund(alice.address, 1000_000000n);
  chain.ledger.fund(bob.address, 1000_000000n);
  // validator = alice with stake
  chain.addValidator(alice.edPublic, Buffer.from(alice.mlPublicKey).toString("base64"), 10000n);
  // ledger account for alice needs edPublic for hybrid verify
  chain.ledger.get(alice.address).edPublic = alice.edPublic;
  const ts = Date.now();
  const msg = Buffer.from([alice.address, bob.address, "1", "0", chain.ledger.get(alice.address).nonce, "test", "aegis.example", ts].join("|"));
  const sig = hybridSign(alice, msg);
  const ledgerTx = { from: alice.address, to: bob.address, amount: 1n, fee: 0n, nonce: 0, intent: "test", domain: "aegis.example", timestamp: ts, sig, mlPublicKeyB64: Buffer.from(alice.mlPublicKey).toString("base64") };
  console.log(`Proposing block with 1 hybrid tx...`);
  const block = chain.propose([ledgerTx as any], alice, 1);
  console.log(`Block height=${block.header.height} hash=${block.hash.slice(0,16)}... sig ed=${block.signature.slice(0,12)}...`);
  console.log(`Accept: ${chain.accept(block)} height=${chain.height} alice bal=${chain.ledger.balance(alice.address)} bob bal=${chain.ledger.balance(bob.address)}`);
  console.log("\n✅ AEGIS TS works: hybrid PQ + anti-AI intent + mesh offline + PoS chain");
}

function walletNew() {
  const k = hybridGenerate();
  console.log(JSON.stringify({ address: k.address, edPublic: k.edPublic.slice(0,24)+"...", mlPubHash: createHash("sha256").update(k.mlPublicKey).digest("hex").slice(0,16)+"...", mlSeed: k.mlSeed.toString("hex") }, null, 2));
  console.log("\nСохрани mlSeed и edPrivate в Hardware Enclave (Passkey-derived). Никогда не публикуй!");
}

/**
 * Send a signed tx to a running node. Used by devnet demo/ops scripts.
 *   tsx cli/aegis.ts send --to=aeg1... --amount=1000 [--rpc=http://127.0.0.1:8899]
 *                        [--seed=<64 hex chars>] [--intent="..."] [--domain=aegis.local]
 *                        [--nullifier=<hex>]  # расход офлайн-ноты: сеть запомнит nullifier
 * Без --seed берётся детерминированный devnet-ключ (тот же, что у `serve`).
 */
async function sendCmd(args: string[]) {
  const arg = (name: string, dflt?: string) => {
    const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return dflt;
    const eq = hit.indexOf("=");
    return eq >= 0 ? hit.slice(eq + 1) : args[args.indexOf(hit) + 1];
  };
  const rpcUrl = (arg("rpc") ?? "http://127.0.0.1:8899").replace(/\/$/, "");
  const to = arg("to");
  if (!to) throw new Error("--to is required");
  const amount = BigInt(arg("amount") ?? "1");
  const intent = arg("intent") ?? "cli transfer";
  const domain = arg("domain") ?? "aegis.local";
  const nullifier = arg("nullifier");
  const seedArg = arg("seed");
  const seed = seedArg
    ? Buffer.from(seedArg, "hex")
    : Buffer.from("aegis-devnet-validator-seed-v07!", "utf8").subarray(0, 32);
  if (seed.length < 32) throw new Error("--seed must be >=32 bytes hex");
  const kp = hybridGenerate(Buffer.from(seed));
  if (!seedArg) console.log("[devnet] using deterministic validator key — pass --seed for other keys");

  const rpc = async (method: string, params: any[]) => {
    const r = await fetch(`${rpcUrl}/api/rpc`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j = await r.json() as any;
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };

  const [acct, gas] = await Promise.all([rpc("aeg_getAccount", [kp.address]), rpc("aeg_gasPrice", [])]);
  const fee = BigInt(gas.suggestedMaxFee ?? gas.baseFee);
  const tx: any = {
    from: kp.address, to, amount, fee, nonce: Number(acct.nonce),
    intent, domain, timestamp: Date.now(),
    sig: { edSig: "", mlSig: "", hybrid: "" },
    mlPublicKeyB64: Buffer.from(kp.mlPublicKey).toString("base64"),
    edPublicB64: kp.edPublic,
    data: "",
  };
  if (nullifier) tx.nullifier = nullifier; // settles an offline note; the ledger records it
  const msg = new Ledger().txMessage(tx);
  tx.sig = hybridSign(kp, msg);
  const json = JSON.parse(JSON.stringify(tx, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  const res = await rpc("aeg_sendTx", [json]);
  console.log(JSON.stringify({ from: kp.address, to, amount: amount.toString(), fee: fee.toString(), nonce: tx.nonce, result: res }, null, 2));
}

async function serveCmd(portArg?: string) {
  const port = portArg ? parseInt(portArg.replace("--port=", "")) : 8899;
  // P2P port derives from the RPC port so several nodes can run on one host
  // (8899→3899 as documented; AEGIS_P2P_PORT overrides, e.g. behind a firewall).
  const p2pPort = Number(process.env.AEGIS_P2P_PORT ?? (port >= 5000 ? port - 5000 : port + 1000));
  console.log(`[aegis] serving on :${port} (rpc+explorer+p2p :${p2pPort})`);
  const { serveNode } = await import("../core-ts/server.js");
  await serveNode(port, p2pPort);
  console.log("Ctrl+C to stop");
}

async function main() {
  const cmd = process.argv[2] || "demo";
  if (cmd === "demo") await demo();
  else if (cmd === "wallet" && process.argv[3] === "new") walletNew();
  else if (cmd === "mesh") await demo();
  else if (cmd === "bench") { const { runBench } = await import("./bench.js"); await runBench(); }
  else if (cmd === "send") await sendCmd(process.argv.slice(3));
  else if (cmd === "serve" || cmd === "node" || cmd === "explorer") await serveCmd(process.argv[3]);
  else console.log("Usage: tsx cli/aegis.ts [demo|mesh|send|serve|node|explorer|bench|wallet new]\n       tsx cli/aegis.ts send --to=aeg1... --amount=1000 [--rpc=URL] [--seed=hex] [--intent=...]");
}
main();
