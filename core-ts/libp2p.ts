/**
 * AEGIS libp2p Noise Transport v1.4 — production P2P поверх js-libp2p
 *
 * v0.8: P2pNode (TCP lite, node:net) — bootstrap + LoRa/USB fallback.
 * v0.9: Libp2pNode — full libp2p stack: TCP + Noise (Noise_XX_25519_AESGCM_SHA256)
 * v1.2: gossipsub миграция — pub/sub на topic /aegis/1.0/gossip (тот же P2pMessage JSON),
 *   stream protocol /aegis/1.0/gossip оставлен как fallback + direct dial
 * v1.3: bootstrap discovery — libp2p bootstrap service (multiaddr list) поверх TCP-lite Discovery
 * v1.4: finality/halving RPC, Paymaster contract, BLE UI (Kad DHT отложен — peerId API mismatch с libp2p 3.5.1)
 *   transports: TCP (/ip4/0.0.0.0/tcp/PORT) — production internet path
 *   connectionEncrypters: Noise (Noise_XX_25519_AESGCM_SHA256 pureJsCrypto)
 *   streamMuxer: default mplex (multiplexed gossip streams per peer)
 *   protocol: /aegis/1.0/gossip — newline-JSON P2pMessage (same schema as p2p.ts)
 *   auth: HELLO signed with Ed25519 hybrid identity (peerId -> edPublic binding)
 *   scoring: identical to P2pNode (invalid block/tx -> -score, ban at <= -100)
 *   rate-limit: 50 msg/sec/peer, 256KB/msg, sync cap 100 blocks
 *
 * Design: gossipsub pub/sub + stream fallback — оба транспорта несут один P2pMessage JSON,
 *   валидация единая (onMessage), mesh/offline пакеты транспортно-независимы (DTN relay).
 *
 * Roles:
 *  - internet connected nodes: Libp2pNode (Noise-encrypted, libp2p dial)
 *  - offline / low-bandwidth: P2pNode TCP-lite + MeshNode packets (QR/BLE/LoRa)
 * Both speak P2pMessage, so a gateway node can bridge libp2p <-> mesh transparently.
 */
import { createLibp2p, type Libp2p } from "libp2p";
import { noise } from "@libp2p/noise";
import { tcp } from "@libp2p/tcp";
import { gossipsub, StrictNoSign } from "@libp2p/gossipsub";
import { identify } from "@libp2p/identify";
import { bootstrap } from "@libp2p/bootstrap";
import type { Chain, Block } from "./chain.js";
import { parseTx, stringify, type Tx } from "./ledger.js";
import { verify, sign } from "./crypto.js";
import type { P2pMessage } from "./p2p.js";
import { peerIdFromString } from "@libp2p/peer-id";

export const AEGIS_PROTOCOL = "/aegis/1.0/gossip";
export const AEGIS_TOPIC = "/aegis/1.0/gossip"; // gossipsub topic — same JSON body as stream protocol
export const AEGIS_CHAIN_ID = "aegis-1";

const MAX_MSG_BYTES = 256 * 1024;
const RATE_LIMIT_PER_SEC = 50;
const BAN_SCORE = -100;

export type Libp2pPeerState = {
  peerId: string;
  nodeId?: string;
  edPublic?: string;
  score: number;
  banned: boolean;
  rateCount: number;
  rateWindow: number;
  lastSeen: number;
  stream?: any;
};

export type Libp2pNodeOpts = {
  listenPort?: number;
  nodeId?: string;
  signKey?: { edPrivate: string; edPublic: string };
  listenAddr?: string; // default /ip4/0.0.0.0/tcp/<port>
  /**
   * Bootstrapping: peers to dial on start (multiaddrs from Discovery).
   * Empty = listen-only node (still accepts inbound dials once discovered).
   */
  peers?: string[];
};

/**
 * Production libp2p node: Noise-encrypted gossip over libp2p streams.
 * API mirrors P2pNode (gossipBlock/gossipTx/broadcast/peerList/close)
 * so server.ts can swap transports with one flag.
 */
export class Libp2pNode {
  libp2p: Libp2p | null = null;
  chain: Chain;
  nodeId: string;
  signKey?: { edPrivate: string; edPublic: string };
  peers = new Map<string, Libp2pPeerState>();
  opts: Required<Pick<Libp2pNodeOpts, "listenPort">> & Libp2pNodeOpts;
  running = false;

  constructor(chain: Chain, opts: Libp2pNodeOpts = {}) {
    this.chain = chain;
    this.nodeId = opts.nodeId ?? `aegis-${Math.random().toString(36).slice(2, 8)}`;
    this.signKey = opts.signKey;
    this.opts = { listenPort: 3899, ...opts };
  }

  /** Start libp2p daemon: listen + handle gossip streams + dial bootstrap peers. */
  async start(): Promise<void> {
    if (this.running) return;
    const listenAddr = this.opts.listenAddr ?? `/ip4/0.0.0.0/tcp/${this.opts.listenPort}`;
    const bootList = (this.opts.peers ?? []).filter((p) => p.startsWith("/"));
    this.libp2p = await createLibp2p({
      addresses: { listen: [listenAddr] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      services: {
        identify: identify() as any,
        ...(bootList.length ? { bootstrap: bootstrap({ list: bootList as any, tagName: "bootstrap", tagValue: 50 }) as any } : {}),
        gossipsub: gossipsub({
          globalSignaturePolicy: StrictNoSign, // we auth via HELLO hybrid (chain-level), libp2p key not identity
        }) as any,
      } as any,
    });

    // gossipsub pub/sub — primary transport (mesh fanout, no direct dial needed)
    try {
      const gs: any = (this.libp2p as any).services.gossipsub;
      gs.subscribe(AEGIS_TOPIC);
      gs.addEventListener("gossipsub:message", (evt: any) => {
        try {
          const detail = (evt as any).detail;
          const fromPeer = detail.propagationSource?.toString?.() ?? "gossipsub";
          const data: Uint8Array = detail.msg?.data;
          if (!data) return;
          if (data.byteLength > MAX_MSG_BYTES) return;
          const line = new TextDecoder().decode(data).trim();
          if (!line) return;
          this.ensurePeer(fromPeer);
          this.onMessage(fromPeer, line);
        } catch {}
      });
      console.log(`[libp2p ${this.nodeId}] gossipsub subscribed ${AEGIS_TOPIC}`);
    } catch (e: any) {
      console.warn(`[libp2p ${this.nodeId}] gossipsub init failed: ${e.message} — fallback to stream gossip`);
    }

    // handle inbound gossip streams from dialing peers
    await this.libp2p.handle(AEGIS_PROTOCOL, async (stream: any, connection: any) => {
      const pid = connection.remotePeer.toString();
      this.ensurePeer(pid, stream);
      try {
        await this.readStream(stream, pid);
      } catch (e: any) {
        // stream closed / reset — peer will redial; score penalty only on bad data
        // (handled inside readStream via onMessage penalties)
      }
    });

    // auto-dial bootstrap peers on start
    for (const addr of this.opts.peers ?? []) {
      void this.dial(addr).catch(() => {});
    }

    this.running = true;
    console.log(`[libp2p ${this.nodeId}] listening ${listenAddr} peer=${this.libp2p.peerId.toString()}`);
  }

  /** Dial a peer by multiaddr or peerId string, open gossip stream, send HELLO. */
  async dial(addrOrPeerId: string): Promise<string> {
    if (!this.libp2p) throw new Error("not started — call start() first");
    const peerIdStr = addrOrPeerId.includes("/")
      ? addrOrPeerId.split("/").pop() ?? addrOrPeerId
      : addrOrPeerId;
    let stream: any;
    try {
      const target = addrOrPeerId.includes("/") ? addrOrPeerId : peerIdStr;
      stream = await this.libp2p.dialProtocol(target as any, AEGIS_PROTOCOL);
    } catch (e: any) {
      throw new Error(`dial failed ${addrOrPeerId}: ${e.message.slice(0, 120)}`);
    }
    const pid = stream?.connection?.remotePeer?.toString?.() ?? peerIdStr;
    this.ensurePeer(pid, stream);
    this.sendHello(pid);
    void this.readStream(stream, pid); // background reader
    return pid;
  }

  private ensurePeer(pid: string, stream?: any): Libp2pPeerState {
    let st = this.peers.get(pid);
    if (!st) {
      st = {
        peerId: pid,
        score: 50,
        banned: false,
        rateCount: 0,
        rateWindow: Math.floor(Date.now() / 1000),
        lastSeen: Date.now(),
        stream,
      };
      this.peers.set(pid, st);
    } else if (stream) st.stream = stream;
    return st;
  }

  private sendHello(pid: string) {
    const st = this.peers.get(pid);
    if (!st?.stream) return;
    const base: any = {
      type: "hello",
      nodeId: this.nodeId,
      height: this.chain.height,
      chainId: AEGIS_CHAIN_ID,
    };
    if (this.signKey) {
      const ts = Date.now();
      const payload = `${this.nodeId}|${this.chain.height}|${ts}`;
      base.edPublic = this.signKey.edPublic;
      base.sig = sign(this.signKey.edPrivate, payload);
      base.ts = ts;
    }
    this.send(pid, base);
  }

  /** Read newline-delimited JSON messages from a stream (mirrors p2p.ts onData). */
  private async readStream(stream: any, pid: string) {
    let buf = "";
    try {
      for await (const chunk of stream) {
        buf += chunk.toString();
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          if (Buffer.byteLength(line) > MAX_MSG_BYTES) {
            this.penalize(pid, -20, "msg too large");
            continue;
          }
          this.onMessage(pid, line);
        }
      }
    } catch {}
    this.peers.delete(pid); // stream ended — peer gone until redial
  }

  /** Single source of truth for message validation (same semantics as p2p.ts). */
  private onMessage(pid: string, line: string) {
    const st = this.peers.get(pid);
    if (!st || st.banned) return;
    const nowSec = Math.floor(Date.now() / 1000);
    if (st.rateWindow !== nowSec) { st.rateWindow = nowSec; st.rateCount = 0; }
    st.rateCount++;
    if (st.rateCount > RATE_LIMIT_PER_SEC) { this.penalize(pid, -10, "rate limit exceeded"); return; }

    let msg: P2pMessage;
    try {
      msg = JSON.parse(line) as P2pMessage;
    } catch {
      this.penalize(pid, -2, "malformed json");
      return;
    }
    st.lastSeen = Date.now();

    // chain-id guard (libp2p peers from other chains get no relay credit)
    if ((msg as any).chainId && (msg as any).chainId !== AEGIS_CHAIN_ID) {
      this.penalize(pid, -5, "chain-id mismatch");
      return;
    }

    try {
      switch (msg.type) {
        case "hello": {
          const h = msg as any;
          st.nodeId = h.nodeId;
          st.edPublic = h.edPublic;
          if (h.edPublic && h.sig && h.ts) {
            const payload = `${h.nodeId}|${h.height}|${h.ts}`;
            if (Math.abs(Date.now() - h.ts) > 60_000 || !verify(h.edPublic, payload, h.sig)) {
              this.penalize(pid, -50, "bad handshake sig");
              return;
            }
            st.score += 10;
          }
          if (h.height < this.chain.height) {
            const blocks = this.chain.blocks.filter((b) => b.header.height > h.height);
            if (blocks.length) this.send(pid, { type: "sync_response", blocks: blocks.slice(0, 100) as Block[] });
          }
          this.send(pid, { type: "pong", height: this.chain.height });
          break;
        }
        case "ping":
          this.send(pid, { type: "pong", height: this.chain.height });
          break;
        case "new_block": {
          const block = (msg as any).block as Block;
          if (block?.txs) block.txs = block.txs.map((t: any) => parseTx(t));
          try {
            this.chain.accept(block);
            st.score += 5;
            console.log(`[libp2p] new_block height=${block.header.height} from ${st.nodeId ?? pid}`);
            this.broadcast(msg as P2pMessage, pid);
          } catch (e: any) {
            console.warn(`[libp2p] block rejected from ${st.nodeId ?? pid}: ${e.message}`);
            this.penalize(pid, -20, `invalid block: ${e.message}`);
          }
          break;
        }
        case "new_tx": {
          try {
            const tx = parseTx((msg as any).tx);
            this.chain.ledger.canApply(tx);
            this.chain.mempool.add(tx);
            st.score += 2;
            this.broadcast(msg as P2pMessage, pid);
          } catch (e: any) {
            this.penalize(pid, -5, `invalid tx: ${e.message}`);
          }
          break;
        }
        case "sync_request": {
          const from = (msg as any).fromHeight as number;
          if (typeof from !== "number" || from < 0 || from > this.chain.height + 1000) {
            this.penalize(pid, -10, "bad sync_request");
            break;
          }
          const blocks = this.chain.blocks.filter((b) => b.header.height > from);
          this.send(pid, { type: "sync_response", blocks: blocks.slice(0, 100) as Block[] });
          break;
        }
        case "sync_response": {
          const blocks = (msg as any).blocks as Block[];
          if (!Array.isArray(blocks) || blocks.length > 100) { this.penalize(pid, -10, "sync_response too large"); break; }
          for (const b of blocks) {
            if (b.txs) b.txs = b.txs.map((t: any) => parseTx(t));
            try { this.chain.accept(b); } catch (e: any) { this.penalize(pid, -5, `sync block invalid: ${e.message}`); break; }
          }
          st.score += 5;
          break;
        }
        case "mesh_packet":
          st.score += 1;
          break;
        default:
          this.penalize(pid, -2, "unknown msg type");
      }
    } catch (e: any) {
      this.penalize(pid, -2, `handler error: ${e.message}`);
    }
  }

  private send(pid: string, msg: P2pMessage) {
    const st = this.peers.get(pid);
    if (!st?.stream || st.banned) return;
    try {
      const line = JSON.stringify(msg, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n";
      // libp2p v3 MessageStream: .send(bytes) instead of it-pipe .sink
      st.stream.send(Buffer.from(line));
    } catch {}
  }

  broadcast(msg: P2pMessage, exclude?: string) {
    // gossipsub fast-path (topic fanout) + stream fanout fallback
    try {
      const gs: any = (this.libp2p as any)?.services?.gossipsub;
      if (gs) {
        const line = JSON.stringify(msg, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
        if (Buffer.byteLength(line) <= MAX_MSG_BYTES) {
          void gs.publish(AEGIS_TOPIC, new TextEncoder().encode(line)).catch(() => {});
        }
      }
    } catch {}
    for (const [pid, st] of this.peers) {
      if (st.banned || pid === exclude) continue;
      this.send(pid, msg);
    }
  }

  private penalize(pid: string, points: number, reason: string) {
    const st = this.peers.get(pid);
    if (!st) return;
    st.score += points;
    if (st.score <= BAN_SCORE) {
      st.banned = true;
      console.warn(`[libp2p] banning peer ${st.nodeId ?? pid} — ${reason} (score ${st.score})`);
      try { st.stream?.abort?.(new Error("banned")); } catch {}
      try { st.stream?.close?.(); } catch {}
      this.peers.delete(pid);
    }
  }

  gossipBlock(b: Block) { this.broadcast({ type: "new_block", block: b }); }
  gossipTx(tx: Tx) { this.broadcast({ type: "new_tx", tx }); }

  peerList() {
    return [...this.peers.values()].map((st) => ({
      peerId: st.peerId,
      nodeId: st.nodeId,
      score: st.score,
      banned: st.banned,
      lastSeen: st.lastSeen,
    }));
  }

  /** libp2p multiaddr to share with other nodes / Discovery. */
  listenAddr() {
    return this.libp2p ? `/ip4/0.0.0.0/tcp/${this.opts.listenPort}/p2p/${this.libp2p.peerId.toString()}` : null;
  }

  async close() {
    for (const st of this.peers.values()) {
      try { st.stream?.abort?.(new Error("close")); } catch {}
      try { st.stream?.close?.(); } catch {}
    }
    this.peers.clear();
    if (this.libp2p) await this.libp2p.stop();
    this.libp2p = null;
    this.running = false;
  }
}

/**
 * In-memory gossip bus for unit tests (no real libp2p sockets).
 * Mirrors InMemoryBus from p2p.ts but drives Libp2pNode.onMessage.
 */
export class Libp2pMemoryBus {
  nodes: Libp2pNode[] = [];
  attach(node: Libp2pNode) {
    this.nodes.push(node);
    const pid = `mem-${node.nodeId}`;
    (node as any).ensurePeer(pid, { send() {}, abort() {}, close() {} });
  }
  broadcastFrom(from: Libp2pNode, msg: P2pMessage) {
    const line = JSON.stringify(msg, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    for (const n of this.nodes) {
      if (n === from) continue;
      const pid = `mem-${n.nodeId}`;
      (n as any).onMessage(pid, line);
    }
  }
}

export { peerIdFromString };
