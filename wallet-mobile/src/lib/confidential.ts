/**
 * AEGIS Confidential Intent (browser) — FHE-lite: intent encrypted with shared secret (AES-GCM).
 * Same wire as core-ts/confidential.ts: Tx.intent = JSON {enc:1, iv, ct} (base64).
 */
function b64encode(buf: Uint8Array): string {
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function keyFromSecret(secret: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
export async function encryptIntent(plaintext: string, secret: string): Promise<{ iv: string; ct: string }> {
  const key = await keyFromSecret(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)));
  return { iv: b64encode(iv), ct: b64encode(ct) };
}
export async function decryptIntent(ivB64: string, ctB64: string, secret: string): Promise<string> {
  const key = await keyFromSecret(secret);
  const iv = b64decode(ivB64) as any;
  const ctbuf = b64decode(ctB64) as any;
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ctbuf);
  return new TextDecoder().decode(pt);
}
export async function toConfIntent(plaintext: string, secret: string): Promise<string> {
  const { iv, ct } = await encryptIntent(plaintext, secret);
  return JSON.stringify({ enc: 1, iv, ct });
}
