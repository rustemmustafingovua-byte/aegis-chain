/**
 * AEGIS BLE Mesh transport (browser) — Web Bluetooth GATT для mesh пакетов.
 *
 * MeshPacket JSON (~1-2KB) чанкуется на 512B characteristics, notify+write.
 * Chrome/Android: navigator.bluetooth. iOS Safari: не поддерживает Web Bluetooth (fallback QR).
 * Используется офлайн: один кошелёк — BLE server (notify), второй — BLE client (read chunks).
 */
const SERVICE_UUID = "0000a1a1-0000-1000-8000-00805f9b34fb"; // AEGIS mesh custom
const CHUNK_BYTES = 512;

export function bleSupported(): boolean {
  return typeof navigator !== "undefined" && !!(navigator as any).bluetooth;
}

function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64decode(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Encode mesh packet(s) for BLE transport: [total, offset, chunkB64] */
export function bleEncode(json: string): string[] {
  const b64 = b64encode(json);
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += CHUNK_BYTES * 4) chunks.push(b64.slice(i, i + CHUNK_BYTES * 4));
  return chunks;
}
export function bleDecode(chunks: string[]): string {
  return b64decode(chunks.join(""));
}

/** Scan BLE server (central side): request device with AEGIS service, read chunks. */
export async function bleScanAndRead(timeoutMs = 15000): Promise<string> {
  if (!bleSupported()) throw new Error("Web Bluetooth не поддерживается (iOS Safari) — используй QR");
  const bt: any = (navigator as any).bluetooth;
  const device = await bt.requestDevice({ filters: [{ services: [SERVICE_UUID] }], optionalServices: [SERVICE_UUID] });
  const server = await device.gatt!.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);
  const chars = await service.getCharacteristics();
  const char = chars[0];
  const chunks: string[] = [];
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value: DataView | undefined = await char.readValue().catch(() => undefined);
    if (value) {
      const txt = new TextDecoder().decode(value);
      if (txt) chunks.push(txt);
      if (chunks.length === 0) break;
      // heuristic: mesh packet JSON ends with } — stop when decode succeeds and ends with }
      try {
        const s = bleDecode(chunks);
        if (s.trim().endsWith("}")) return s;
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("BLE read timeout");
}

export const BLE_INFO = { service: SERVICE_UUID, chunk: CHUNK_BYTES, docs: "docs/MESH.md#ble" };
