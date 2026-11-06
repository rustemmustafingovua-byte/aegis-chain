/**
 * AEGIS Mesh — DTN / epidemic gossip, QR/BLE/LoRa transports
 */
import { sha256 } from "./crypto.js";
import type { OfflineTx } from "./autonomy.js";
import { offlineSign } from "./autonomy.js";
import type { HybridKeypair } from "./hybrid.js";

export type MeshPacket = {
  type: "AEGIS_PACKET";
  v: "0.4";
  tx: OfflineTx;
  txHash: string;
  nullifier: string;
  hops: number;
  ttl: number;
  priority: string;
  origin: string;
  createdAt: number;
  transport: "QR" | "BLE" | "WIFI_DIRECT" | "LORA" | "USB";
};

export function makePacket(tx: OfflineTx, transport: MeshPacket["transport"] = "QR", ttl = 8): MeshPacket {
  return { type: "AEGIS_PACKET", v: "0.4", tx, txHash: tx.txHash, nullifier: tx.nullifier, hops: 0, ttl, priority: "normal", origin: tx.from, createdAt: Date.now(), transport };
}
export function packetEncode(p: MeshPacket): Buffer {
  return Buffer.from(JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
export function packetDecode(data: Buffer): MeshPacket {
  const raw = JSON.parse(data.toString());
  raw.tx.amount = BigInt(raw.tx.amount);
  return raw as MeshPacket;
}
export function packetSize(p: MeshPacket): number { return packetEncode(p).length; }

export class MeshNode {
  nodeId: string;
  keys: HybridKeypair;
  addr: string;
  mempool = new Map<string, OfflineTx>();
  seenNullifiers = new Set<string>();
  peers = new Set<string>();
  offlineQueue: MeshPacket[] = [];
  snapshot = { height: 0, hash: sha256("genesis").slice(0, 16) };
  seq = 0;
  stats = { received: 0, forwarded: 0, dedup: 0, conflicts: 0 };
  constructor(nodeId: string, keys: HybridKeypair) {
    this.nodeId = nodeId;
    this.keys = keys;
    this.addr = keys.address;
  }
  connect(peer: MeshNode) { this.peers.add(peer.nodeId); peer.peers.add(this.nodeId); }
  disconnect(peer: MeshNode) { this.peers.delete(peer.nodeId); peer.peers.delete(this.nodeId); }

  receive(p: MeshPacket): string {
    const { txHash, nullifier } = p;
    if (this.mempool.has(txHash)) { this.stats.dedup++; return "dedup"; }
    if (this.seenNullifiers.has(nullifier)) { this.stats.conflicts++; return "conflict: nullifier spent"; }
    if (p.tx.amount <= 0n) return "rejected: bad amount";
    if (p.tx.expiry * 1000 < Date.now()) return "rejected: expired";
    if (p.hops > p.ttl) return "rejected: ttl exceeded";
    this.mempool.set(txHash, p.tx);
    this.seenNullifiers.add(nullifier);
    this.stats.received++;
    return "accepted";
  }
  gossip(nodes: Record<string, MeshNode>) {
    const log: string[] = [];
    for (const pid of this.peers) {
      const peer = nodes[pid];
      if (!peer) continue;
      for (const tx of this.mempool.values()) {
        const pkt = makePacket(tx);
        pkt.hops = 1;
        const s = peer.receive(pkt);
        this.stats.forwarded++;
        log.push(`${this.nodeId}->${peer.nodeId}: ${s}`);
      }
    }
    return log;
  }
  signOffline(to: string, amount: bigint, intent: string, domain: string, entropy: Buffer) {
    const tx = offlineSign(this.keys, this.addr, to, amount, intent, domain, entropy, this.snapshot.height, this.snapshot.hash, this.seq++);
    this.mempool.set(tx.txHash, tx);
    this.seenNullifiers.add(tx.nullifier);
    return tx;
  }
  queueForCarry(p: MeshPacket) { this.offlineQueue.push(p); }
  flushCarry(nodes: Record<string, MeshNode>): number {
    let flushed = 0;
    const remaining: MeshPacket[] = [];
    for (const pkt of this.offlineQueue) {
      let delivered = false;
      for (const pid of this.peers) {
        const peer = nodes[pid];
        if (peer && (peer.receive(pkt) === "accepted" || peer.receive(pkt) === "dedup")) { flushed++; delivered = true; break; }
      }
      if (!delivered) remaining.push(pkt);
    }
    this.offlineQueue = remaining;
    return flushed;
  }
  syncOnline(global: { height: number; spent: Set<string>; txs: Map<string, OfflineTx> }): number {
    let accepted = 0;
    for (const tx of this.mempool.values()) {
      if (global.spent.has(tx.nullifier)) { this.stats.conflicts++; continue; }
      global.spent.add(tx.nullifier);
      global.txs.set(tx.txHash, tx);
      accepted++;
    }
    global.height += accepted;
    this.snapshot.height = global.height;
    this.snapshot.hash = sha256(String(global.height)).slice(0, 16);
    return accepted;
  }
}
