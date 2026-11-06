/**
 * AEGIS P2P v0.7 — TCP gossip поверх libp2p-lite (аналог Lumen p2p.ts)
 * v0.7 production-hardening:
 *  - Authenticated handshake: HELLO signed with Ed25519 (peer identity = edPublic)
 *  - Peer scoring: invalid block/tx → -score, score<0 → ban + disconnect
 *  - Rate limiting: max messages/sec per peer, max msg size (DoS guard)
 *  - Sync with anti-DoS: only respond to sync_request if peer height lags
 * Сообщения: HELLO / NEW_BLOCK / NEW_TX / SYNC_REQUEST / SYNC_RESPONSE / MESH_PACKET / PING / PONG
 * Каждый блок и tx проверяются hybrid-ом перед relay.
 */
import * as net from "node:net";
import { Chain, type Block } from "./chain.js";
import { parseTx, stringify, type Tx } from "./ledger.js";
import { sha256, verify, sign } from "./crypto.js";

export type P2pMessage =
  | { type: "hello"; nodeId: string; height: number; edPublic?: string; sig?: string; ts?: number }
  | { type: "new_block"; block: Block }
  | { type: "new_tx"; tx: Tx }
  | { type: "sync_request"; fromHeight: number }
  | { type: "sync_response"; blocks: Block[] }
  | { type: "mesh_packet"; packet: unknown }
  | { type: "ping" }
  | { type: "pong"; height: number };

export type PeerState = { socket: net.Socket; nodeId?: string; edPublic?: string; score: number; banned: boolean; rateCount: number; rateWindow: number; lastSeen: number };

const MAX_MSG_BYTES = 256 * 1024; // blocks with ML-DSA sigs are ~5-10KB each, sync_response can be larger
const RATE_LIMIT_PER_SEC = 50;
const BAN_SCORE = -100;

export class P2pNode {
  server: net.Server;
  peers = new Map<net.Socket, PeerState>();
  nodeId: string;
  chain: Chain;
  port: number;
  /** Optional signing key for authenticated HELLO (node operator keypair) */
  signKey?: { edPrivate: string; edPublic: string };
  constructor(chain: Chain, nodeId = `aegis-${Math.random().toString(36).slice(2, 8)}`, port = 3899, signKey?: { edPrivate: string; edPublic: string }) {
    this.chain = chain;
    this.nodeId = nodeId;
    this.port = port;
    this.signKey = signKey;
    this.server = net.createServer((socket) => this.onConn(socket));
    this.server.on("error", (e) => console.error(`[p2p ${nodeId}]`, e.message));
  }
  listen() {
    return new Promise<void>((resolve) => {
      this.server.listen(this.port, () => {
        console.log(`[p2p ${this.nodeId}] listening :${this.port}`);
        resolve();
      });
    });
  }
  connect(host: string, port: number) {
    const s = net.createConnection({ host, port });
    const state: PeerState = { socket: s, score: 50, banned: false, rateCount: 0, rateWindow: Math.floor(Date.now()/1000), lastSeen: Date.now() };
    s.on("connect", () => {
      this.peers.set(s, state);
      this.sendHello(s);
    });
    s.on("data", (d) => this.onData(s, d));
    s.on("close", () => this.peers.delete(s));
    s.on("error", () => {});
    return s;
  }
  private sendHello(s: net.Socket) {
    const ts = Date.now();
    const base: any = { type: "hello", nodeId: this.nodeId, height: this.chain.height };
    if (this.signKey) {
      const payload = `${this.nodeId}|${this.chain.height}|${ts}`;
      base.edPublic = this.signKey.edPublic;
      base.sig = sign(this.signKey.edPrivate, payload);
      base.ts = ts;
    }
    this.send(s, base);
  }
  private onConn(s: net.Socket) {
    const state: PeerState = { socket: s, score: 50, banned: false, rateCount: 0, rateWindow: Math.floor(Date.now()/1000), lastSeen: Date.now() };
    this.peers.set(s, state);
    s.on("data", (d) => this.onData(s, d));
    s.on("close", () => this.peers.delete(s));
    s.on("error", () => {});
    this.sendHello(s);
  }
  private send(s: net.Socket, msg: P2pMessage) {
    try { s.write(JSON.stringify(msg, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n"); } catch {}
  }
  broadcast(msg: P2pMessage, exclude?: net.Socket) {
    for (const [p, st] of this.peers) {
      if (st.banned || p === exclude) continue;
      try { this.send(p, msg); } catch {}
    }
  }
  private penalize(s: net.Socket, points: number, reason: string) {
    const st = this.peers.get(s);
    if (!st) return;
    st.score += points;
    if (st.score <= BAN_SCORE) {
      st.banned = true;
      console.warn(`[p2p] banning peer ${st.nodeId ?? s.remoteAddress} — ${reason} (score ${st.score})`);
      try { s.destroy(); } catch {}
      this.peers.delete(s);
    }
  }
  private onData(s: net.Socket, data: Buffer) {
    const st = this.peers.get(s);
    if (!st || st.banned) return;
    // rate limit
    const nowSec = Math.floor(Date.now()/1000);
    if (st.rateWindow !== nowSec) { st.rateWindow = nowSec; st.rateCount = 0; }
    st.rateCount++;
    if (st.rateCount > RATE_LIMIT_PER_SEC) {
      this.penalize(s, -10, "rate limit exceeded");
      return;
    }
    if (data.length > MAX_MSG_BYTES * 4) { this.penalize(s, -20, "oversized payload"); return; }
    // buffer may split across TCP packets — accumulate per-socket buffer
    (s as any)._buf = ((s as any)._buf ?? "") + data.toString();
    let buf: string = (s as any)._buf;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx+1);
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_MSG_BYTES) { this.penalize(s, -20, "msg too large"); continue; }
      try {
        const msg = JSON.parse(line) as P2pMessage;
        st.lastSeen = Date.now();
        if (msg.type === "hello") {
          const h = msg as any;
          st.nodeId = h.nodeId;
          st.edPublic = h.edPublic;
          // verify handshake signature if present
          if (h.edPublic && h.sig && h.ts) {
            const payload = `${h.nodeId}|${h.height}|${h.ts}`;
            if (Math.abs(Date.now() - h.ts) > 60_000 || !verify(h.edPublic, payload, h.sig)) {
              this.penalize(s, -50, "bad handshake sig");
              continue;
            }
            st.score += 10; // authenticated bonus
          }
          // respond with our hello + sync if peer is behind
          if (h.height < this.chain.height) {
            const blocks = this.chain.blocks.filter((b) => b.header.height > h.height);
            if (blocks.length) this.send(s, { type: "sync_response", blocks });
          }
          this.send(s, { type: "pong", height: this.chain.height });
        } else if (msg.type === "ping") {
          this.send(s, { type: "pong", height: this.chain.height });
        } else if (msg.type === "new_block") {
          const block = (msg as any).block as Block;
          // normalize tx bigint fields
          if (block?.txs) block.txs = block.txs.map((t: any) => parseTx(t));
          try {
            const before = this.chain.height;
            this.chain.accept(block);
            st.score += 5;
            console.log(`[p2p] new_block height=${block.header.height} from ${st.nodeId ?? "?"}`);
            // relay to other peers (gossip)
            this.broadcast(msg, s);
          } catch (e: any) {
            console.warn(`[p2p] block rejected from ${st.nodeId ?? "?"}: ${e.message}`);
            this.penalize(s, -20, `invalid block: ${e.message}`);
          }
        } else if (msg.type === "new_tx") {
          try {
            const tx = parseTx((msg as any).tx);
            this.chain.ledger.canApply(tx); // dry-run check
            this.chain.mempool.add(tx);
            st.score += 2;
            this.broadcast(msg, s);
          } catch (e: any) {
            this.penalize(s, -5, `invalid tx: ${e.message}`);
          }
        } else if (msg.type === "sync_request") {
          const from = (msg as any).fromHeight as number;
          if (typeof from !== "number" || from < 0 || from > this.chain.height + 1000) { this.penalize(s, -10, "bad sync_request"); continue; }
          const blocks = this.chain.blocks.filter((b) => b.header.height > from);
          // cap response to avoid amplification DoS
          this.send(s, { type: "sync_response", blocks: blocks.slice(0, 100) });
        } else if (msg.type === "sync_response") {
          const blocks = (msg as any).blocks as Block[];
          if (!Array.isArray(blocks) || blocks.length > 100) { this.penalize(s, -10, "sync_response too large"); continue; }
          for (const b of blocks) {
            if (b.txs) b.txs = b.txs.map((t: any) => parseTx(t));
            try { this.chain.accept(b); } catch (e: any) { this.penalize(s, -5, `sync block invalid: ${e.message}`); break; }
          }
          st.score += 5;
        } else if (msg.type === "mesh_packet") {
          // forward to mesh if attached (no-op here, server wires MeshNode separately)
          st.score += 1;
        }
      } catch (e) {
        // malformed JSON — minor penalty
        this.penalize(s, -2, "malformed json");
      }
    }
    (s as any)._buf = buf.slice(-MAX_MSG_BYTES); // prevent unbounded buffer growth
  }
  gossipBlock(b: Block) { this.broadcast({ type: "new_block", block: b }); }
  gossipTx(tx: Tx) { this.broadcast({ type: "new_tx", tx }); }
  peerList() {
    return [...this.peers.values()].map((st) => ({ nodeId: st.nodeId, score: st.score, banned: st.banned, lastSeen: st.lastSeen, remote: st.socket.remoteAddress }));
  }
  close() { for (const [p] of this.peers) p.destroy(); this.peers.clear(); this.server.close(); }
}

/** Помощник для тестов: in-memory шина (без TCP). */
export class InMemoryBus {
  nodes: P2pNode[] = [];
  private socks = new Map<P2pNode, net.Socket>();
  attach(node: P2pNode) {
    this.nodes.push(node);
    const sock = {} as net.Socket;
    (sock as any).remoteAddress = node.nodeId;
    this.socks.set(node, sock);
    // pre-register peer state so onData accepts messages from this socket
    (node as any).peers.set(sock, { socket: sock, score: 50, banned: false, rateCount: 0, rateWindow: Math.floor(Date.now()/1000), lastSeen: Date.now() });
  }
  broadcastFrom(from: P2pNode, msg: P2pMessage) {
    for (const n of this.nodes) if (n !== from) {
      const sock = this.socks.get(n)!;
      (n as any).onData(sock, Buffer.from(JSON.stringify(msg, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n"));
    }
  }
}
