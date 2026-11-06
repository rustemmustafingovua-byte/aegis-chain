/**
 * AEGIS RPC v0.8 — JSON-RPC 2.0 поверх HTTP (как Lumen)
 * Методы: aeg_getState, aeg_getBlock, aeg_getBalance, aeg_sendTx, aeg_meshStatus, aeg_sync
 * v0.7: aeg_sendTx validates (canApply) before mempool, + pool/stake/gov/bridge methods
 */
import * as http from "node:http";
import { Chain } from "./chain.js";
import { stringify, parseTx } from "./ledger.js";
import { MeshNode } from "./mesh.js";
import { Governance } from "./governance.js";
import { Bridge } from "./bridge.js";
import type { P2pNode } from "./p2p.js";

type RpcRequest = { jsonrpc: string; id: number | string; method: string; params: any[] };
type RpcResponse = { jsonrpc: "2.0"; id: number | string; result?: unknown; error?: { code: number; message: string } };

export type RpcDeps = { gov?: Governance; bridge?: Bridge; p2p?: P2pNode };

export function createRpcServer(chain: Chain, mesh?: MeshNode, deps: RpcDeps = {}) {
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

    if (req.url === "/health") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: true, height: chain.height, version: "0.8.0" })); }
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
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const reqJson = JSON.parse(body) as RpcRequest;
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
      case "aeg_getBlocks": return chain.blocks.slice(-(params[0] ?? 20)).map((b) => ({ height: b.header.height, hash: b.hash, txCount: b.header.txCount }));
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
        // gossip to peers if attached
        try { deps.p2p?.gossipTx(tx); } catch {}
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
      case "aeg_bridgeQuote": {
        const [usdcIn, ammBase, ammQuote] = [params[0], params[1], params[2]];
        if (!deps.bridge) throw new Error("bridge not attached");
        const out = deps.bridge.quoteBaseToAegis(BigInt(usdcIn), BigInt(ammBase), BigInt(ammQuote));
        return { usdcIn: usdcIn.toString(), aegisOut: out.toString() };
      }
      case "aeg_validatorList": return [...chain.validators.entries()].map(([pk, v]) => ({ edPublic: pk, stake: v.stake.toString(), address: v.address ?? null }));
      case "aeg_peerList": return deps.p2p ? deps.p2p.peerList() : [];
      case "aeg_meshStatus": return mesh ? { mempool: mesh.mempool.size, peers: [...mesh.peers], stats: mesh.stats, snapshot: mesh.snapshot } : { mesh: "not attached" };
      case "aeg_sync": return { height: chain.height, blocks: chain.blocks.length, stateRoot: chain.ledger.stateRoot() };
      default: throw new Error(`unknown method ${method}`);
    }
  }
  return server;
}
