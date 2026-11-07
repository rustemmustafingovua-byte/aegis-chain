/**
 * AEGIS Server v0.9 — RPC + Explorer + P2P в одном процессе (как lumen serve --port=8899)
 * v0.9: persistence (state file), auto-proposer loop with slot timer,
 * wires MeshNode for offline settlement, Governance + Bridge,
 * dual transport: P2pNode (TCP lite, bootstrap/LoRa fallback) + Libp2pNode (Noise, production).
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Chain, SLOT_MS } from "./chain.js";
import { createRpcServer } from "./rpc.js";
import { P2pNode } from "./p2p.js";
import { Libp2pNode } from "./libp2p.js";
import { Wal, walPaths, WAL_SNAPSHOT_EVERY } from "./wal.js";
import { Governance } from "./governance.js";
import { Bridge } from "./bridge.js";
import { Discovery, BOOTSTRAP } from "./discovery.js";
import { hybridGenerate, type HybridKeypair } from "./hybrid.js";
import { MeshNode } from "./mesh.js";

export type ServeOpts = {
  port?: number;
  p2pPort?: number;
  stateFile?: string; // persisted chain snapshot (default ~/.local/state/aegis-chain.json)
  autoPropose?: boolean; // produce empty/thin blocks on slot timer (default true if mempool>0)
  validatorSeed?: Buffer; // deterministic single-node validator for devnet
};

export async function serveNode(port = 8899, p2pPort = 3899, opts: ServeOpts = {}) {
  const stateFile = opts.stateFile ?? path.join(process.env.HOME ?? ".", ".local/state/aegis-chain.json");
  // validator is deterministic from seed — same key after restart, so auto-propose keeps working
  const seed = opts.validatorSeed ?? Buffer.from("aegis-devnet-validator-seed-v07!", "utf8").subarray(0, 32);
  const validator = hybridGenerate(Buffer.from(seed));
  // 1) load or genesis
  let chain = Chain.loadFromFile(stateFile);
  let gov: Governance | null = null;
  if (!chain) {
    chain = new Chain();
    chain.genesis();
    // devnet single validator so node produces blocks immediately (Lumen devnet model)
    chain.ledger.fund(validator.address, 100_000_000000n);
    chain.ledger.get(validator.address).edPublic = validator.edPublic;
    chain.ledger.get(validator.address).humanityScore = 90;
    chain.addValidator(validator.edPublic, Buffer.from(validator.mlPublicKey).toString("base64"), 10_000_000000n, validator.address);
    // seed AMM pool AEGIS/USDC so quote/swap work out of the box
    chain.ledger.addLiquidity("AEGIS/USDC", 1_000_000_000000n, 1_000_000_000000n, validator.address);
    (globalThis as any).__aegisValidator = validator;
    try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); chain.saveToFile(stateFile); } catch (e: any) { console.warn("[aegis] genesis persist failed:", e.message); }
    console.log(`[aegis] devnet genesis created, validator ${validator.address} (funded 100k, staked 10k)`);
  } else {
    console.log(`[aegis] restored chain from ${stateFile} height=${chain.height}`);
    // re-register deterministic validator if chain was loaded without it
    if (!chain.validators.has(validator.edPublic)) {
      chain.addValidator(validator.edPublic, Buffer.from(validator.mlPublicKey).toString("base64"), 10_000_000000n, validator.address);
      chain.ledger.get(validator.address).edPublic = validator.edPublic;
    }
  }
  gov = new Governance(chain);
  const bridge = new Bridge();
  const discovery = new Discovery();
  for (const b of BOOTSTRAP) discovery.add(b);
  // mesh node bound to validator (offline settlement endpoint)
  const mesh = validator ? new MeshNode(`aegis-node-${port}`, validator) : undefined;
  const deps: { gov: Governance; bridge: Bridge; p2p?: any } = { gov, bridge };
  const rpc = createRpcServer(chain, mesh, deps);
  // static explorer + RPC proxy in one HTTP server
  const here = (import.meta as any).dirname ?? path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "../explorer");
  const httpServer = http.createServer((req, res) => {
    if (req.url?.startsWith("/api/") || req.url === "/rpc" || req.url === "/health" || req.url === "/metrics") {
      return rpc.emit("request", req, res);
    }
    const file = req.url === "/" ? path.join(root, "index.html") : path.join(root, req.url!);
    // path traversal guard
    const resolved = path.resolve(file);
    if (!resolved.startsWith(root)) { res.writeHead(403); return res.end("forbidden"); }
    fs.readFile(resolved, (err, data) => {
      if (err) { res.writeHead(404); return res.end("not found"); }
      const ext = path.extname(resolved);
      const ctype = ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "text/html";
      res.writeHead(200, { "Content-Type": ctype });
      res.end(data);
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(port, () => resolve()));
  console.log(`[aegis] node+rpc+explorer on :${port} height=${chain.height}`);
  // dual transport: P2pNode (TCP lite, bootstrap/LoRa fallback) + Libp2pNode (Noise, production)
  const p2p = new P2pNode(chain, `aegis-node-${port}`, p2pPort, validator ? { edPrivate: validator.edPrivate, edPublic: validator.edPublic } : undefined);
  await p2p.listen();
  deps.p2p = p2p; // wire p2p into RPC deps (late-binding)
  const libp2pNode = new Libp2pNode(chain, {
    listenPort: p2pPort + 1000,
    nodeId: `aegis-node-${port}`,
    signKey: validator ? { edPrivate: validator.edPrivate, edPublic: validator.edPublic } : undefined,
  });
  await libp2pNode.start();
  (deps as any).libp2p = libp2pNode;
  // auto-proposer: produce block each slot if mempool non-empty or validator idle
  let slot = chain.height + 1;
  let timer: NodeJS.Timeout | null = null;
  if (validator) {
    const tick = () => {
      try {
        // only propose if we are the slot proposer
        const expected = chain.proposerForSlot(slot);
        if (expected === validator.edPublic) {
          if (chain.mempool.size > 0) {
            const block = chain.produceNextBlock(validator, slot);
            p2p.gossipBlock(block);
            libp2pNode.gossipBlock(block);
            console.log(`[aegis] produced block height=${block.header.height} txs=${block.header.txCount}`);
            // WAL append (durable) + snapshot every WAL_SNAPSHOT_EVERY blocks
            try {
              const { walPath, snapshotPath } = walPaths(stateFile);
              const wal = new Wal(walPath, snapshotPath);
              wal.append(block);
              if (block.header.height % WAL_SNAPSHOT_EVERY === 0) wal.compact(chain);
              else chain.saveToFile(stateFile);
            } catch (e: any) { console.warn("[aegis] persist failed:", e.message); }
          } else {
            // idle tick: advance slot counter without empty blocks (avoid chain bloat)
          }
          slot++;
        }
      } catch (e: any) {
        console.warn("[aegis] auto-propose error:", e.message);
      }
    };
    timer = setInterval(tick, SLOT_MS);
    // also expose manual tick for tests
    (httpServer as any).__aegisTick = tick;
    (httpServer as any).__aegisValidator = validator;
  }
  const stop = () => {
    if (timer) clearInterval(timer);
    p2p.close();
    void libp2pNode.close();
    httpServer.close();
    try { chain.saveToFile(stateFile); } catch {}
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return { chain, httpServer, p2p, libp2pNode, gov, bridge, discovery, mesh, validator, stop };
}
