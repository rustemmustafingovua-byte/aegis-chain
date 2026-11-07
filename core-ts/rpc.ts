/**
 * AEGIS RPC v1.1 — JSON-RPC 2.0 поверх HTTP (как Lumen)
 * Методы: aeg_getState, aeg_getBlock, aeg_getBalance, aeg_sendTx, aeg_meshStatus, aeg_sync
 * v0.7: aeg_sendTx validates (canApply) before mempool, + pool/stake/gov/bridge methods
 * v1.1: + aeg_faucet (devnet), aeg_registerValidator, aeg_metrics / /metrics, libp2p gossip
 */
import * as http from "node:http";
import { createHash } from "node:crypto";
import { Chain } from "./chain.js";
import { stringify, parseTx } from "./ledger.js";
import { MeshNode } from "./mesh.js";
import { Governance } from "./governance.js";
import { Bridge } from "./bridge.js";
import type { P2pNode } from "./p2p.js";
import type { Libp2pNode } from "./libp2p.js";

type RpcRequest = { jsonrpc: string; id: number | string; method: string; params: any[] };
type RpcResponse = { jsonrpc: "2.0"; id: number | string; result?: unknown; error?: { code: number; message: string } };

export type RpcDeps = { gov?: Governance; bridge?: Bridge; p2p?: P2pNode; libp2p?: Libp2pNode };

const ADMIN_METHODS = new Set(["aeg_faucet", "aeg_slash", "aeg_registerValidator", "aeg_commitMlKey", "aeg_prune", "aeg_checkpoint"]);

export function createRpcServer(chain: Chain, mesh?: MeshNode, deps: RpcDeps = {}) {
  // per-IP token bucket rate limit (100 req/s default, env AEGIS_RPC_RATE_LIMIT)
  const rateWindow = new Map<string, { count: number; ts: number }>();
  const RATE_LIMIT = Number(process.env.AEGIS_RPC_RATE_LIMIT ?? 100);
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, x-admin-token");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

    // rate limit
    const ip = (req.socket.remoteAddress ?? "unknown").split(",")[0].trim();
    const nowSec = Math.floor(Date.now() / 1000);
    const slot = rateWindow.get(ip) ?? { count: 0, ts: nowSec };
    if (slot.ts !== nowSec) rateWindow.set(ip, { count: 1, ts: nowSec });
    else if (++slot.count > RATE_LIMIT) {
      res.writeHead(429, { "Retry-After": String(60 - (Date.now() % 60_000) / 1000), "Content-Type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32002, message: "rate limit exceeded" } }));
    }

    if (req.url === "/health") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: true, height: chain.height, version: "1.10.0" })); }
    if (req.url === "/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      const lines = [
        `aegis_height ${chain.height}`,
        `aegis_mempool ${chain.mempool.size}`,
        `aegis_blocks ${chain.blocks.length}`,
        `aegis_accounts ${chain.ledger.accounts.size}`,
        `aegis_validators ${chain.validators.size}`,
        `aegis_supply ${chain.ledger.totalSupply().toString()}`,
        `aegis_state_root "${chain.ledger.stateRoot()}"`,
        `aegis_uptime_seconds ${Math.floor(process.uptime())}`,
      ];
      return res.end(lines.join("\n") + "\n");
    }
    if (req.url === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const pools = [...chain.ledger.pools.entries()].map(([key, p]) => ({
        key, base: p.base.toString(), quote: p.quote.toString(), feeBps: p.feeBps.toString(),
        totalShares: p.totalShares.toString(),
        price: p.base > 0n ? (Number(p.quote) / Number(p.base)).toFixed(6) : "0",
      }));
      const proposals = deps.gov ? [...deps.gov.proposals.values()].map((p) => ({
        id: p.id, title: p.title, action: p.action, proposer: p.proposer, status: p.status,
        votesFor: p.votesFor.toString(), votesAgainst: p.votesAgainst.toString(), humanityVotes: p.humanityVotes,
      })) : [];
      const peers = deps.p2p ? deps.p2p.peerList() : [];
      return res.end(JSON.stringify({
        height: chain.height,
        head: chain.head ? { hash: chain.head.hash, height: chain.head.header.height, txCount: chain.head.header.txCount } : null,
        mempool: chain.mempool.size,
        supply: chain.ledger.totalSupply().toString(),
        stateRoot: chain.ledger.stateRoot(),
        validators: [...chain.validators.values()].map((v) => ({ edPublic: v.publicKey.slice(0, 20) + "…", stake: v.stake.toString(), address: v.address ?? null })),
        accounts: [...chain.ledger.accounts.entries()].map(([addr, a]) => ({ addr, balance: a.balance.toString(), stake: a.stake.toString(), nonce: a.nonce, humanityScore: a.humanityScore ?? null })),
        pools,
        proposals,
        peers,
        blocks: chain.blocks.slice(-20).map((b) => ({ height: b.header.height, hash: b.hash.slice(0, 16), txCount: b.header.txCount, timestamp: b.header.timestamp, proposer: b.header.proposer.slice(0, 12) + "…" })),
      }));
    }
    if (req.method !== "POST" || !(req.url === "/api/rpc" || req.url === "/rpc")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "not found" }));
    }
    let body = "";
    let bytes = 0;
    req.on("data", (c) => { bytes += c.length; if (bytes > 1_048_576) { res.writeHead(413, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "body too large" } })); req.destroy(); return; } body += c; });
    req.on("end", () => {
      if (bytes > 1_048_576) return;
      try {
        const reqJson = JSON.parse(body) as RpcRequest;
        if (!reqJson.method || typeof reqJson.method !== "string") throw new Error("bad method");
        if (!Array.isArray(reqJson.params)) throw new Error("bad params");
        const adminTok = (req.headers["x-admin-token"] as string) ?? "";
        const expected = process.env.AEGIS_ADMIN_TOKEN ?? "";
        if (ADMIN_METHODS.has(reqJson.method) && expected && adminTok !== expected) {
          throw new Error("admin token required (AEGIS_ADMIN_TOKEN)");
        }
        const result = dispatch(reqJson.method, reqJson.params || []);
        const resp: RpcResponse = { jsonrpc: "2.0", id: reqJson.id, result };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(resp));
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: e.message } }));
      }
    });
  });

  function dispatch(method: string, params: any[]) {
    switch (method) {
      case "aeg_getState": return { height: chain.height, head: chain.head?.hash ?? null, supply: chain.ledger.totalSupply().toString(), stateRoot: chain.ledger.stateRoot() };
      case "aeg_getBlock": {
        const h = params[0] as number;
        const b = chain.blocks.find((x) => x.header.height === h);
        return b ? JSON.parse(stringify(b)) : null;
      }
      case "aeg_getBlocks": {
        // backward compat: [limit] = last N; [offset, limit] = paginated window
        if (params.length >= 2) {
          const offset = Number(params[0] ?? 0);
          const limit = Math.min(Number(params[1] ?? 20), 100);
          return chain.blocks.slice(offset, offset + limit).map((b) => ({ height: b.header.height, hash: b.hash, txCount: b.header.txCount }));
        }
        return chain.blocks.slice(-(Number(params[0] ?? 20))).map((b) => ({ height: b.header.height, hash: b.hash, txCount: b.header.txCount }));
      }
      case "aeg_getBalance": return chain.ledger.balance(params[0] as string).toString();
      case "aeg_getAccount": {
        const a = chain.ledger.accounts.get(params[0] as string);
        return a ? { address: a.address, balance: a.balance.toString(), stake: a.stake.toString(), nonce: a.nonce, humanityScore: a.humanityScore ?? null, pendingUnstake: (a.pendingUnstake ?? 0n).toString() } : null;
      }
      case "aeg_sendTx": {
        // v0.7: validate before mempool (was blind add — spam vector)
        const tx = parseTx(params[0]);
        chain.ledger.canApply(tx);
        chain.mempool.add(tx);
        // gossip to peers if attached (dual transport)
        try { deps.p2p?.gossipTx(tx); } catch {}
        try { (deps as any).libp2p?.gossipTx(tx); } catch {}
        return { accepted: true, mempool: chain.mempool.size, txHash: chain.ledger.stateRoot().slice(0, 16) };
      }
      case "aeg_swapQuote": {
        const [key, amount] = [params[0] as string, params[1]];
        const out = chain.ledger.quoteSwap(key, BigInt(amount));
        return { key, amountIn: amount.toString(), amountOut: out.toString() };
      }
      case "aeg_poolInfo": {
        const p = params[0] ? chain.ledger.pool(params[0] as string) : [...chain.ledger.pools.values()][0];
        return p ? { base: p.base.toString(), quote: p.quote.toString(), feeBps: p.feeBps.toString(), totalShares: p.totalShares.toString() } : null;
      }
      case "aeg_govPropose": {
        if (!deps.gov) throw new Error("governance not attached");
        const [id, title, action, proposer] = params as string[];
        deps.gov.create(id, title, action, proposer);
        return { created: id };
      }
      case "aeg_govVote": {
        if (!deps.gov) throw new Error("governance not attached");
        const [id, voter, support] = params as [string, string, boolean];
        deps.gov.vote(id, voter, !!support);
        const p = deps.gov.tally(id);
        return p ? JSON.parse(stringify(p)) : null;
      }
      case "aeg_govList": {
        if (!deps.gov) return [];
        return [...deps.gov.proposals.values()].map((p) => JSON.parse(stringify(p)));
      }
      case "aeg_govExecute": {
        if (!deps.gov) throw new Error("governance not attached");
        return deps.gov.execute(params[0] as string);
      }
      case "aeg_bridgeQuote": {
        const [usdcIn, ammBase, ammQuote] = [params[0], params[1], params[2]];
        if (!deps.bridge) throw new Error("bridge not attached");
        const out = deps.bridge.quoteBaseToAegis(BigInt(usdcIn), BigInt(ammBase), BigInt(ammQuote));
        return { usdcIn: usdcIn.toString(), aegisOut: out.toString() };
      }
      case "aeg_validatorList": return [...chain.validators.entries()].map(([pk, v]) => ({ edPublic: pk, stake: v.stake.toString(), address: v.address ?? null }));
      case "aeg_peerList": return deps.p2p ? deps.p2p.peerList() : [];
      case "aeg_libp2pPeers": return (deps as any).libp2p ? (deps as any).libp2p.peerList() : [];
      case "aeg_meshStatus": return mesh ? { mempool: mesh.mempool.size, peers: [...mesh.peers], stats: mesh.stats, snapshot: mesh.snapshot } : { mesh: "not attached" };
      case "aeg_faucet": {
        // devnet faucet — disabled in prod (mainnet custody). Rate-limited per address.
        if (process.env.AEGIS_FAUCET === "off") throw new Error("faucet disabled");
        const [addr, amountRaw] = params as [string, string?];
        if (!addr || !addr.startsWith("aeg1")) throw new Error("bad address");
        const amount = BigInt(amountRaw ?? "10000000000"); // default 10k AEGIS
        if (amount <= 0n || amount > 1_000_000_000_000n) throw new Error("bad amount");
        const acct = chain.ledger.get(addr);
        if ((acct as any)._faucetCount > 5) throw new Error("faucet rate limit (5/address)");
        (acct as any)._faucetCount = ((acct as any)._faucetCount ?? 0) + 1;
        chain.ledger.fund(addr, amount);
        return { funded: addr, amount: amount.toString(), balance: chain.ledger.balance(addr).toString() };
      }
      case "aeg_registerValidator": {
        const [edPublic, mlPublicKeyB64, stakeRaw, address] = params as [string, string, string, string?];
        if (!edPublic || !mlPublicKeyB64) throw new Error("bad keys");
        const stake = BigInt(stakeRaw);
        if (stake < 10_000n * 1_000_000n) throw new Error("min stake 10k AEGIS");
        if (address) {
          const bal = chain.ledger.balance(address);
          if (bal < stake) throw new Error("insufficient balance for stake");
        }
        chain.addValidator(edPublic, mlPublicKeyB64, stake, address);
        return { registered: edPublic.slice(0, 20) + "…", stake: stake.toString() };
      }
      case "aeg_slash": {
        const [addr, bpsRaw] = params as [string, string?];
        if (!addr || !addr.startsWith("aeg1")) throw new Error("bad address");
        const bps = BigInt(bpsRaw ?? "1000");
        if (bps <= 0n || bps > 10000n) throw new Error("bad bps");
        const cut = chain.ledger.slash(addr, bps);
        return { slashed: addr, bps: bps.toString(), cut: cut.toString() };
      }
      case "aeg_metrics": return { height: chain.height, mempool: chain.mempool.size, blocks: chain.blocks.length, validators: chain.validators.size, uptime: Math.floor(process.uptime()) };
      case "aeg_walStatus": return { wal: "aegis-chain.wal.ndjson", height: chain.height, blocks: chain.blocks.length, snapshotEvery: 1000 };
      case "aeg_finality": return { finalized: chain.isFinalized(), height: chain.height, totalStake: chain.totalStake().toString() };
      case "aeg_halving": return { height: chain.height, halvingFactor: chain.halvingFactor(), halvingEvery: 7_884_000 * 4 };
      case "aeg_snapshot": return chain.snapshot();
      case "aeg_checkpoint": {
        // v1.6: checkpoint = snapshot + prune to 100 + WAL compact (single call)
        chain.prune(100);
        return { checkpoint: chain.snapshot(), prunedHeight: chain.prunedHeight };
      }
      case "aeg_commitMlKey": {
        // v1.8: PQ hash commitment — store mlPublicHash for account (full 1952B key off-chain, hash on-chain)
        const [addr, mlHash, mlPublicKeyB64] = params as [string, string, string?];
        if (!addr || !addr.startsWith("aeg1")) throw new Error("bad address");
        if (!mlHash || mlHash.length !== 64) throw new Error("bad mlHash (sha256 hex)");
        const acct = chain.ledger.get(addr);
        if (mlPublicKeyB64) {
          const pub = Buffer.from(mlPublicKeyB64, "base64");
          if (pub.length !== 1952) throw new Error("ml pub must be 1952B");
          const h = createHash("sha256").update(pub).digest("hex");
          if (h !== mlHash) throw new Error("hash mismatch");
        }
        acct.mlPublicHash = mlHash;
        return { committed: addr, mlPublicHash: mlHash };
      }
      case "aeg_prune": return { prunedHeight: chain.prune(Number(params[0] ?? 100)) };
      case "aeg_sync": return { height: chain.height, blocks: chain.blocks.length, stateRoot: chain.ledger.stateRoot() };
      default: throw new Error(`unknown method ${method}`);
    }
  }
  return server;
}
