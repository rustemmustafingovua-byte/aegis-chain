/**
 * AEGIS Server v1.10 — RPC + Explorer + P2P в одном процессе (как lumen serve --port=8899)
 * v0.9: persistence (state file), auto-proposer loop with slot timer,
 * wires MeshNode for offline settlement, Governance + Bridge,
 * dual transport: P2pNode (TCP lite, bootstrap/LoRa fallback) + Libp2pNode (Noise, production).
 * v1.10: central config (AEGIS_* env), structured logger, graceful shutdown drain.
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Chain, SLOT_MS } from "./chain.js";
import { createRpcServer } from "./rpc.js";
import { P2pNode } from "./p2p.js";
import { Libp2pNode } from "./libp2p.js";
import { Wal, walPaths, WAL_SNAPSHOT_EVERY, replayWal } from "./wal.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { Governance } from "./governance.js";
import { Bridge } from "./bridge.js";
import { Discovery, BOOTSTRAP } from "./discovery.js";
import { hybridGenerate, type HybridKeypair } from "./hybrid.js";
import { MeshNode } from "./mesh.js";
import { PasskeyRegistry } from "./webauthn.js";
import { CheckpointStore, createCheckpoint } from "./checkpoints.js";

export type ServeOpts = {
  port?: number;
  p2pPort?: number;
  stateFile?: string; // persisted chain snapshot (default ~/.local/state/aegis-chain.json)
  autoPropose?: boolean; // produce empty/thin blocks on slot timer (default true if mempool>0)
  validatorSeed?: Buffer; // deterministic single-node validator for devnet
  /**
   * Idle heartbeat: if the mempool is empty, still produce an empty block every N slots
   * (0 = never, default). Keeps a devnet chain (and therefore its checkpoints and
   * light-client anchors) advancing. Set AEGIS_EMPTY_BLOCK_SLOTS=15 for ~1 block/min.
   */
  emptyBlockSlots?: number;
};

export async function serveNode(port = loadConfig().port, p2pPort = loadConfig().p2pPort, opts: ServeOpts = {}) {
  const cfg = loadConfig({ port, p2pPort });
  const stateFile = opts.stateFile ?? cfg.stateFile;
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
    try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); chain.saveToFile(stateFile); } catch (e: any) { logger.warn("genesis persist failed", { error: e.message }); }
    logger.info("genesis", { validator: validator.address });
  } else {
    logger.info("restored", { stateFile, height: chain.height });
    // re-register deterministic validator if chain was loaded without it
    if (!chain.validators.has(validator.edPublic)) {
      chain.addValidator(validator.edPublic, Buffer.from(validator.mlPublicKey).toString("base64"), 10_000_000000n, validator.address);
      chain.ledger.get(validator.address).edPublic = validator.edPublic;
    }
  }
  // v1.13: durability — snapshot + WAL replay (recovers blocks written after the last snapshot)
  try {
    const { walPath } = walPaths(stateFile);
    const r = replayWal(chain, walPath);
    if (r.applied > 0 || r.corrupt) logger.info("wal replay", { applied: r.applied, skipped: r.skipped, corrupt: r.corrupt, height: r.height });
  } catch (e: any) { logger.warn("wal replay failed", { error: e.message }); }

  gov = new Governance(chain);
  const bridge = new Bridge();
  // v1.12: passkey bindings live next to the chain snapshot
  const passkeyFile = stateFile.replace(/\.json$/, "-passkeys.json");
  let passkeys = new PasskeyRegistry();
  try {
    if (fs.existsSync(passkeyFile)) passkeys = PasskeyRegistry.fromJSON(JSON.parse(fs.readFileSync(passkeyFile, "utf8")));
  } catch (e: any) { logger.warn("passkey registry load failed", { error: e.message }); }
  const checkpointFile = stateFile.replace(/\.json$/, "-checkpoints.json");
  let checkpoints = new CheckpointStore();
  try {
    if (fs.existsSync(checkpointFile)) checkpoints = CheckpointStore.fromJSON(JSON.parse(fs.readFileSync(checkpointFile, "utf8")));
  } catch (e: any) { logger.warn("checkpoint store load failed", { error: e.message }); }
  const saveCheckpoints = () => { try { fs.writeFileSync(checkpointFile, JSON.stringify(checkpoints.toJSON())); } catch { /* best effort */ } };
  // fresh devnet: publish a checkpoint immediately so light clients have an anchor
  if (validator && !checkpoints.latest()) { checkpoints.add(createCheckpoint(chain, validator)); saveCheckpoints(); }
  const discovery = new Discovery();
  for (const b of BOOTSTRAP) discovery.add(b);
  // mesh node bound to validator (offline settlement endpoint)
  const mesh = validator ? new MeshNode(`aegis-node-${port}`, validator) : undefined;
  const deps: { gov: Governance; bridge: Bridge; p2p?: any; passkeys: PasskeyRegistry; checkpoints: CheckpointStore; validator?: HybridKeypair; saveCheckpoints: () => void } = { gov, bridge, passkeys, checkpoints, validator, saveCheckpoints };
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
  logger.info("serving", { port, height: chain.height });
  // dual transport: P2pNode (TCP lite, bootstrap/LoRa fallback) + Libp2pNode (Noise, production)
  const p2p = new P2pNode(chain, `aegis-node-${port}`, p2pPort, validator ? { edPrivate: validator.edPrivate, edPublic: validator.edPublic } : undefined);
  await p2p.listen();
  deps.p2p = p2p; // wire p2p into RPC deps (late-binding)
  const libp2pNode = new Libp2pNode(chain, {
    listenPort: p2pPort + 1000,
    nodeId: `aegis-node-${port}`,
    signKey: validator ? { edPrivate: validator.edPrivate, edPublic: validator.edPublic } : undefined,
  });
  try {
    await libp2pNode.start();
  } catch (e: any) {
    // A busy P2P port must not take down RPC/explorer: run single-transport (TCP lite).
    logger.warn("libp2p start failed, continuing with TCP p2p only", { error: e.message });
  }
  (deps as any).libp2p = libp2pNode;
  // auto-proposer: produce block each slot if mempool non-empty or validator idle
  let slot = chain.height + 1;
  let timer: NodeJS.Timeout | null = null;
  const wal = (() => { const { walPath, snapshotPath } = walPaths(stateFile); return new Wal(walPath, snapshotPath); })();
  const emptyBlockSlots = opts.emptyBlockSlots ?? (Number(process.env.AEGIS_EMPTY_BLOCK_SLOTS ?? 0) || 0);
  const checkpointEvery = Number(process.env.AEGIS_CHECKPOINT_EVERY ?? 10) > 0 ? Number(process.env.AEGIS_CHECKPOINT_EVERY ?? 10) : 10;
  if (validator) {
    // one place that turns a produced block into durable state (WAL, passkeys, checkpoint)
    const persistBlock = (block: ReturnType<Chain["produceNextBlock"]>) => {
      p2p.gossipBlock(block);
      libp2pNode.gossipBlock(block);
      logger.info("produced", {
        height: block.header.height, txs: block.header.txCount,
        baseFee: chain.feeMarket.baseFee.toString(), empty: block.header.txCount === 0,
      });
      try { fs.writeFileSync(passkeyFile, JSON.stringify(passkeys.toJSON())); } catch { /* best effort */ }
      // v1.13: WAL append per block (cheap), full snapshot every WAL_SNAPSHOT_EVERY.
      // Crash recovery = snapshot + replayWal; no full JSON rewrite per block.
      try {
        wal.append(block);
        if (block.header.height % WAL_SNAPSHOT_EVERY === 0) wal.compact(chain);
      } catch (e: any) { logger.warn("persist failed", { error: e.message }); }
      // signed checkpoint every N blocks (light-client anchor, AEGIS_CHECKPOINT_EVERY)
      if (block.header.height % checkpointEvery === 0) {
        try {
          const cp = createCheckpoint(chain, validator);
          checkpoints.add(cp);
          saveCheckpoints();
          logger.info("checkpoint", { height: cp.height, stateRoot: cp.stateRoot.slice(0, 16) });
        } catch (e: any) { logger.warn("checkpoint failed", { error: e.message }); }
      }
    };
    const tick = () => {
      try {
        // only propose if we are the slot proposer
        const expected = chain.proposerForSlot(slot);
        if (expected === validator.edPublic) {
          const hasTx = chain.mempool.size > 0;
          const heartbeat = !hasTx && emptyBlockSlots > 0 && slot % emptyBlockSlots === 0;
          if (hasTx || heartbeat) {
            persistBlock(chain.produceNextBlock(validator, slot));
          }
          // else idle tick: advance the slot counter without producing a block (avoid bloat)
          slot++;
        }
      } catch (e: any) {
        logger.warn("auto-propose error", { error: e.message });
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
  return { chain, httpServer, p2p, libp2pNode, gov, bridge, discovery, mesh, validator, checkpoints, stop };
}
