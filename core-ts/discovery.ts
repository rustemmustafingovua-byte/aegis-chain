/**
 * AEGIS Peer Discovery — bootstrap + Kademlia-lite (как libp2p DHT light)
 * Без DHT-тяжести: bootstrap list по умолчанию, ping/pong, обмен peer lists.
 */
import * as net from "node:net";

export type PeerInfo = { id: string; host: string; port: number; lastSeen: number; score: number };
export const BOOTSTRAP: PeerInfo[] = [
  { id: "aegis-boot-1", host: "localhost", port: 3899, lastSeen: 0, score: 0 },
];

export class Discovery {
  peers = new Map<string, PeerInfo>();
  bootstrap: PeerInfo[] = BOOTSTRAP;
  add(peer: PeerInfo) { this.peers.set(peer.id, { ...peer, lastSeen: Date.now() }); }
  list(): PeerInfo[] { return [...this.peers.values()].sort((a, b) => b.score - a.score); }
  ping(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const s = net.createConnection({ host, port }, () => { s.end(); resolve(true); });
      s.setTimeout(2000, () => { s.destroy(); resolve(false); });
      s.on("error", () => resolve(false));
    });
  }
  exchange(theirPeers: PeerInfo[]) {
    for (const p of theirPeers) if (!this.peers.has(p.id)) this.add(p);
  }
  distance(a: string, b: string): number {
    // hex length diff placeholder for Kademlia XOR distance
    let d = 0; const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) d++;
    return d;
  }
  closest(nodeId: string, k = 20): PeerInfo[] {
    return this.list().sort((a, b) => this.distance(a.id, nodeId) - this.distance(b.id, nodeId)).slice(0, k);
  }
}
