/**
 * AEGIS LoRa Transport v1.9 — chunked radio frames for LoRa (MTU ~51B, SF7)
 *
 * MeshPacket JSON (~1-2KB) → frames [seq, total, chunk(base64)] → reassemble in order.
 * Radio drivers (SX1262 Heltec, RAK4631) can call reassemble() on receive. No link-layer needed:
 * security is hybrid sig + nullifier (see mesh.ts), LoRa is just MTU-constrained transport.
 */
export const LORA_MTU = 51;
export const LORA_MAX_FRAMES = 200; // ~10KB max payload

export type LoraFrame = { seq: number; total: number; data: string };

export function loraChunk(json: string, mtu = LORA_MTU): LoraFrame[] {
  const b64 = Buffer.from(json, "utf8").toString("base64");
  const frames: LoraFrame[] = [];
  const chunkSize = Math.max(16, Math.floor(mtu * 0.8)); // base64 payload per frame with overhead
  for (let i = 0; i < b64.length; i += chunkSize) {
    frames.push({ seq: Math.floor(i / chunkSize), total: Math.ceil(b64.length / chunkSize), data: b64.slice(i, i + chunkSize) });
  }
  if (frames.length > LORA_MAX_FRAMES) throw new Error("lora: packet too large for radio");
  return frames;
}

export function loraReassemble(frames: LoraFrame[]): string {
  if (!frames.length) throw new Error("lora: no frames");
  const total = frames[0].total;
  if (frames.length !== total) throw new Error(`lora: missing frames ${frames.length}/${total}`);
  const sorted = [...frames].sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < total; i++) if (sorted[i].seq !== i) throw new Error(`lora: gap at seq ${i}`);
  const b64 = sorted.map((f) => f.data).join("");
  return Buffer.from(b64, "base64").toString("utf8");
}

export const LORA_INFO = { mtu: LORA_MTU, maxFrames: LORA_MAX_FRAMES, docs: "docs/MESH.md#lora" };
