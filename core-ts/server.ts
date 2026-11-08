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
import { Chain, SLOT_MS, GENESIS_TIMESTAMP } from "./chain.js";
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
import { sha256 } from "./crypto.js";
import { MeshNode } from "./mesh.js";
import { PasskeyRegistry } from "./webauthn.js";
import { CheckpointStore, createCheckpoint, verifyCheckpoint, type Checkpoint } from "./checkpoints.js";
import { applyGenesisConfig, genesisFromEnv } from "./genesis.js";
import { validatorViewOf } from "./headers.js";

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

/** v1.16: per-node key comes from env so several nodes on one host differ. */
function seedFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.AEGIS_VALIDATOR_SEED;
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64,}$/.test(raw)) return Buffer.from(raw, "hex").subarray(0, 32);
  // any human-readable label → deterministic 32-byte seed (never short)
  return Buffer.from(sha256(raw), "hex");
}

export async function serveNode(port = loadConfig().port, p2pPort = loadConfig().p2pPort, opts: ServeOpts = {}) {
  const cfg = loadConfig({ port, p2pPort });
  const stateFile = opts.stateFile ?? cfg.stateFile;
  // validator is deterministic from seed — same key after restart, so auto-propose keeps working
  const seed = opts.validatorSeed ?? seedFromEnv() ?? Buffer.from("aegis-devnet-validator-seed-v07!", "utf8").subarray(0, 32);
  const ownKey = hybridGenerate(Buffer.from(seed));
  // v1.16: shared genesis config → multi-validator devnet. A node whose key is not
  // in the set runs as an observer (no auto-propose) instead of forking the chain.
  const genesisCfg = genesisFromEnv();
  const validator: HybridKeypair | null =
    genesisCfg && !genesisCfg.validators.some((v) => v.edPublic === ownKey.edPublic) ? null : ownKey;
  // 1) load or genesis
  let chain = Chain.loadFromFile(stateFile);
  let gov: Governance | null = null;
  if (!chain) {
    chain = new Chain();
    chain.genesis();
    if (genesisCfg) {
      // identical, sorted application on every node → identical ledger/stateRoot
      const applied = applyGenesisConfig(chain, genesisCfg, { fresh: true });
      const poolOwner = [...genesisCfg.validators].sort((a, b) => (a.edPublic < b.edPublic ? -1 : 1))[0]?.address ?? ownKey.address;
      chain.ledger.addLiquidity("AEGIS/USDC", 1_000_000_000000n, 1_000_000_000000n, poolOwner);
      logger.info("genesis from config", { validators: genesisCfg.validators.length, ...applied, proposer: validator?.address ?? "observer" });
    } else {
      // devnet single validator so node produces blocks immediately (Lumen devnet model)
      chain.ledger.fund(ownKey.address, 100_000_000000n);
      chain.ledger.get(ownKey.address).edPublic = ownKey.edPublic;
      chain.ledger.get(ownKey.address).humanityScore = 90;
      chain.addValidator(ownKey.edPublic, Buffer.from(ownKey.mlPublicKey).toString("base64"), 10_000_000000n, ownKey.address);
      // seed AMM pool AEGIS/USDC so quote/swap work out of the box
      chain.ledger.addLiquidity("AEGIS/USDC", 1_000_000_000000n, 1_000_000_000000n, ownKey.address);
      logger.info("genesis", { validator: ownKey.address });
    }
    (globalThis as any).__aegisValidator = ownKey;
    try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); chain.saveToFile(stateFile); } catch (e: any) { logger.warn("genesis persist failed", { error: e.message }); }
  } else {
    logger.info("restored", { stateFile, height: chain.height });
    if (genesisCfg) {
      // idempotent: never re-fund balances on restore, only fill missing validator entries
      applyGenesisConfig(chain, genesisCfg, { fresh: false });
    } else if (validator && !chain.validators.has(validator.edPublic)) {
      // re-register deterministic validator if chain was loaded without it
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
  // v1.16: peers that co-sign our checkpoints, so a light client sees a real 2/3
  // quorum instead of a single validator's promise. URLs: "http://host:port,..."
  const cpPeers = (process.env.AEGIS_CHECKPOINT_PEERS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const postRpc = async (base: string, method: string, params: any[]) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    try {
      const r = await fetch(`${base.replace(/\/$/, "")}/api/rpc`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j: any = await r.json();
      return j.result;
    } finally { clearTimeout(t); }
  };
  /**
   * Offers a checkpoint to peers and merges their signatures.
   * Retries a few times: block gossip and checkpoint creation race, so a peer may
   * still be a block behind when the first offer arrives.
   */
  const collectCheckpointSignatures = async (initial: Checkpoint) => {
    if (!cpPeers.length || !validator) return;
    let best = initial;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (verifyCheckpoint(best, validatorViewOf(chain)).ok) break;
      for (const peer of cpPeers) {
        try {
          const res = await postRpc(peer, "aeg_checkpointOffer", [best]);
          if (res?.signed && res.checkpoint) {
            checkpoints.add(res.checkpoint as Checkpoint);
            best = checkpoints.at(best.height) ?? best;
          }
        } catch { /* peer down or behind — retry below */ }
      }
      if (verifyCheckpoint(best, validatorViewOf(chain)).ok) break;
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
    saveCheckpoints();
    const v = verifyCheckpoint(best, validatorViewOf(chain));
    logger.info("checkpoint quorum", {
      height: best.height, signatures: best.signatures.length, signedBps: v.signedBps, ok: v.ok,
    });
  };
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
  // v1.16: join an existing devnet (AEGIS_BOOTSTRAP="host:port,host:port")
  for (const hp of (process.env.AEGIS_BOOTSTRAP ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [host, portStr] = hp.split(":");
    const pnum = Number(portStr);
    if (!host || !Number.isInteger(pnum)) { logger.warn("bad bootstrap peer", { peer: hp }); continue; }
    try { p2p.addBootstrap(host, pnum); logger.info("bootstrap dial", { host, port: pnum }); } catch (e: any) { logger.warn("bootstrap failed", { peer: hp, error: e.message }); }
  }
  deps.p2p = p2p; // wire p2p into RPC deps (late-binding)
  const libp2pPeers = (process.env.AEGIS_LIBP2P_PEERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const libp2pNode = new Libp2pNode(chain, {
    listenPort: Number(process.env.AEGIS_LIBP2P_PORT ?? p2pPort + 1000),
    nodeId: `aegis-node-${port}`,
    signKey: validator ? { edPrivate: validator.edPrivate, edPublic: validator.edPublic } : undefined,
    peers: libp2pPeers,
  });
  try {
    await libp2pNode.start();
  } catch (e: any) {
    // A busy P2P port must not take down RPC/explorer: run single-transport (TCP lite).
    logger.warn("libp2p start failed, continuing with TCP p2p only", { error: e.message });
  }
  (deps as any).libp2p = libp2pNode;
  // auto-proposer: wall-clock slots so every node agrees on the slot number
  // (v1.16: a counter incremented only by the elected proposer desynchronises
  //  multi-validator nodes — they stop proposing after the first foreign block)
  const currentSlot = () => Math.floor((Date.now() - GENESIS_TIMESTAMP) / SLOT_MS);
  let lastProducedSlot = -1;
  let noQuorumTicks = 0;
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
          // fire-and-forget: never block block production on peer latency
          if (cpPeers.length) void collectCheckpointSignatures(cp);
        } catch (e: any) { logger.warn("checkpoint failed", { error: e.message }); }
      }
    };
    const tick = () => {
      try {
        const slot = currentSlot();
        if (slot <= lastProducedSlot) return; // one block per slot, never two
        if (chain.head?.header?.slot === slot) return; // a peer already filled this slot
        // v1.16: do not propose without a live quorum — a partitioned validator that
        // keeps mining creates an unfixable fork (there is no reorg yet).
        const totalStake = chain.totalStake();
        if (totalStake > 0n) {
          const visible = new Set<string>([validator.edPublic]);
          for (const p of p2p.peerList()) if (p.edPublic) visible.add(p.edPublic);
          let connectedStake = 0n;
          for (const [pk, v] of chain.validators) if (visible.has(pk)) connectedStake += v.stake;
          // exact 2/3 (2-of-3 must pass; 6667 bps rounding would wrongly require 3-of-3
          // in a star topology where each leaf sees only the bootstrap node)
          if (connectedStake * 3n < totalStake * 2n) {
            noQuorumTicks++;
            if (noQuorumTicks % 10 === 1) logger.warn("proposal skipped: no quorum", { connected: (connectedStake * 10_000n / totalStake).toString() + " bps", peers: visible.size - 1 });
            return;
          }
          noQuorumTicks = 0;
        }
        // only propose if we are the slot proposer
        const expected = chain.proposerForSlot(slot);
        if (expected === validator.edPublic) {
          const hasTx = chain.mempool.size > 0;
          const heartbeat = !hasTx && emptyBlockSlots > 0 && slot % emptyBlockSlots === 0;
          if (hasTx || heartbeat) {
            persistBlock(chain.produceNextBlock(validator, slot));
            lastProducedSlot = slot;
          }
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
