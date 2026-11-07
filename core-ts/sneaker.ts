/**
 * AEGIS Sneaker Transport v1.8 — USB/Bluetooth-file mesh (DTN sneakernet)
 *
 * Store-carry-forward без сети: MeshNode.saveQueue(file) → флэшка → loadQueue на другой ноде.
 * scripts/sneaker-sync.sh копирует aegis-mesh-queue.json. LoRa — аналогично через serial файл.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { MeshNode, packetEncode, packetDecode, type MeshPacket } from "./mesh.js";

export type SneakerPacketFile = {
  nodeId: string;
  exportedAt: number;
  packets: string[]; // base64(json) per packet
};

export function sneakerExport(node: MeshNode, filePath: string) {
  const payload: SneakerPacketFile = {
    nodeId: node.nodeId,
    exportedAt: Date.now(),
    packets: node.offlineQueue.map((p) => packetEncode(p).toString("base64")),
  };
  fs.writeFileSync(filePath, JSON.stringify(payload), "utf8");
  return payload.packets.length;
}

export function sneakerImport(filePath: string, nodes: Record<string, MeshNode>): number {
  if (!fs.existsSync(filePath)) return 0;
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8")) as SneakerPacketFile;
  let accepted = 0;
  for (const b64 of payload.packets) {
    const pkt = packetDecode(Buffer.from(b64, "base64")) as MeshPacket;
    for (const node of Object.values(nodes)) {
      if (node.receive(pkt) === "accepted") { accepted++; break; }
    }
  }
  return accepted;
}

export function sneakerStatus(filePath: string) {
  if (!fs.existsSync(filePath)) return { exists: false };
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8")) as SneakerPacketFile;
  return { exists: true, nodeId: payload.nodeId, exportedAt: payload.exportedAt, packets: payload.packets.length };
}
