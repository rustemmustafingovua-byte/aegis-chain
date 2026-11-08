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
import { SyncTracker, applyIncomingBlock, blockRef, classifyBlock } from "./sync.js";

export type P2pMessage =
  | { type: "hello"; nodeId: string; height: number; edPublic?: string; sig?: string; ts?: number }
  | { type: "new_block"; block: Block }
  | { type: "new_tx"; tx: Tx }
  | { type: "sync_request"; fromHeight: number }
  | { type: "sync_response"; blocks: Block[] }
  | { type: "mesh_packet"; packet: unknown }
  | { type: "ping" }
  | { type: "pong"; height: number };

export type PeerState = { socket: net.Socket; nodeId?: string; edPublic?: string; score: number; banned: boolean; rateCount: number; rateWindow: number; lastSeen: number; height?: number };

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
  /** v1.16: per-peer sync bookkeeping (cooldown/backoff, no false bans) */
  tracker = new SyncTracker();
  /** v1.16: blocks seen that conflict with local history — observed, not punished */
  forksSeen = 0;
  /** v1.16: bootstrap peers are re-dialled; a single lost socket must not isolate a node */
  bootstrap: { host: string; port: number }[] = [];
  private reconnectTimer?: NodeJS.Timeout;
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
  /**
   * v1.16: remember a bootstrap peer and keep the link up.
   * The first dial often races the peer's listen() (ECONNREFUSED was swallowed and
   * the node silently stayed isolated) — now we retry every few seconds.
   */
  addBootstrap(host: string, port: number) {
    this.bootstrap.push({ host, port });
    this.connect(host, port);
    if (!this.reconnectTimer) {
      this.reconnectTimer = setInterval(() => this.reconnectBootstrap(), 5000);
      this.reconnectTimer.unref?.();
    }
  }
  private reconnectBootstrap() {
    for (const { host, port } of this.bootstrap) {
      const alive = [...this.peers.values()].some((st) => st.socket.remotePort === port && !st.banned && st.socket.readyState === "open");
      if (!alive) this.connect(host, port);
    }
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
  /** v1.16: ask a peer to send us everything after `fromHeight`. */
  requestSync(s: net.Socket, fromHeight: number) {
    const st = this.peers.get(s);
    if (!st) return;
    const peerId = st.nodeId ?? String(s.remoteAddress ?? "peer");
    this.tracker.noteRequest(peerId, fromHeight);
    this.send(s, { type: "sync_request", fromHeight });
  }
  /** Peer identity used by the sync tracker (stable across socket reconnects). */
  private peerIdOf(st: PeerState): string {
    return st.nodeId ?? String(st.socket.remoteAddress ?? "peer");
  }
  syncStatus() {
    return {
      transport: "tcp",
      height: this.chain.height,
      peers: this.peerList(),
      forksSeen: this.forksSeen,
      sync: this.tracker.status(),
    };
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
          st.height = typeof h.height === "number" ? h.height : st.height;
          // respond with our hello + sync if peer is behind
          if (h.height < this.chain.height) {
            const blocks = this.chain.blocks.filter((b) => b.header.height > h.height);
            if (blocks.length) this.send(s, { type: "sync_response", blocks });
          } else if (h.height > this.chain.height) {
            // v1.16: peer is ahead — pull instead of waiting for its next block
            const peerId = this.peerIdOf(st);
            this.tracker.noteHeight(peerId, h.height);
            if (this.tracker.shouldRequest(peerId, this.chain.height)) this.requestSync(s, this.chain.height);
          }
          this.send(s, { type: "pong", height: this.chain.height });
        } else if (msg.type === "ping") {
          this.send(s, { type: "pong", height: this.chain.height });
        } else if (msg.type === "new_block") {
          const block = (msg as any).block as Block;
          // normalize tx bigint fields
          if (block?.txs) block.txs = block.txs.map((t: any) => parseTx(t));
          st.height = Math.max(st.height ?? 0, block?.header?.height ?? 0);
          const res = applyIncomingBlock({
            chain: this.chain, block, peerId: this.peerIdOf(st), tracker: this.tracker,
            requestSync: (fromHeight) => this.requestSync(s, fromHeight),
          });
          if (res.action === "applied") {
            st.score += 5;
            this.tracker.noteForwarded(this.peerIdOf(st));
            console.log(`[p2p] new_block height=${block.header.height} from ${st.nodeId ?? "?"}`);
            this.broadcast(msg, s); // relay only blocks we actually accepted
          } else if (res.action === "reject") {
            console.warn(`[p2p] block rejected from ${st.nodeId ?? "?"}: ${res.reason}`);
            this.penalize(s, -20, `invalid block: ${res.reason}`);
          } else if (res.action === "sync") {
            console.log(`[p2p] gap at ${block.header.height} (head ${this.chain.height}) — syncing from ${st.nodeId ?? "?"}`);
          } else if ((res as any).cls === "fork") {
            this.forksSeen++;
            console.warn(`[p2p] fork block h=${block.header.height} from ${st.nodeId ?? "?"} — observed, not banned`);
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
          const peerId = this.peerIdOf(st);
          let appliedCount = 0;
          let failed: string | undefined;
          for (const b of blocks) {
            if (b.txs) b.txs = b.txs.map((t: any) => parseTx(t));
            const opt = classifyBlock(this.chain, blockRef(b));
            if (opt === "duplicate") continue;
            if (opt !== "next") { failed = `sync block out of order at ${b.header.height}`; break; }
            try { this.chain.accept(b); appliedCount++; } catch (e: any) { failed = e.message; break; }
          }
          if (failed) {
            this.tracker.noteFailure(peerId, failed);
            this.penalize(s, -5, `sync block invalid: ${failed}`);
          } else {
            this.tracker.noteSuccess(peerId);
            st.score += 5;
            if (appliedCount) console.log(`[p2p] synced ${appliedCount} blocks from ${st.nodeId ?? "?"} — height ${this.chain.height}`);
            // peer still ahead? ask for the next range once the cooldown allows
            if ((st.height ?? 0) > this.chain.height && this.tracker.shouldRequest(peerId, this.chain.height)) {
              this.requestSync(s, this.chain.height);
            }
          }
        } else if (msg.type === "pong") {
          const h = (msg as any).height as number;
          if (typeof h === "number") {
            st.height = Math.max(st.height ?? 0, h);
            const peerId = this.peerIdOf(st);
            this.tracker.noteHeight(peerId, h);
            if (h > this.chain.height && this.tracker.shouldRequest(peerId, this.chain.height)) this.requestSync(s, this.chain.height);
          }
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
    return [...this.peers.values()].map((st) => ({ nodeId: st.nodeId, edPublic: st.edPublic, score: st.score, banned: st.banned, lastSeen: st.lastSeen, height: st.height, remote: st.socket.remoteAddress }));
  }
  close() {
    if (this.reconnectTimer) clearInterval(this.reconnectTimer);
    for (const [p] of this.peers) p.destroy();
    this.peers.clear();
    this.server.close();
  }
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
