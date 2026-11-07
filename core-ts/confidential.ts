/**
 * AEGIS Confidential Intent v1.9 — FHE-lite: intent encrypted with out-of-band shared secret.
 *
 * Chain signs the CIPHERTEXT as `intent` (canonical includes cipher) — network/mesh relay
 * sees only AES-GCM cipher, not plaintext. Recipient decrypts with same shared secret
 * (shared via QR/sneaker, never on-chain). No FHE hardware needed — confidentiality via
 * AEAD, integrity via hybrid sig over cipher.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

function keyFromSecret(secret: string): Buffer {
  return createHash("sha256").update(secret).digest(); // 32B AES-256 key
}

export function encryptIntent(plaintext: string, sharedSecret: string): { iv: string; ct: string } {
  const key = keyFromSecret(sharedSecret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString("base64"), ct: Buffer.concat([ct, tag]).toString("base64") };
}

export function decryptIntent(ivB64: string, ctB64: string, sharedSecret: string): string {
  const key = keyFromSecret(sharedSecret);
  const iv = Buffer.from(ivB64, "base64");
  const raw = Buffer.from(ctB64, "base64");
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(0, raw.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Wire format stored in Tx.intent when confidential: JSON {enc:1, iv, ct} */
export function toConfIntent(plaintext: string, sharedSecret: string): string {
  const { iv, ct } = encryptIntent(plaintext, sharedSecret);
  return JSON.stringify({ enc: 1, iv, ct });
}

export function fromConfIntent(intent: string, sharedSecret: string): string {
  const j = JSON.parse(intent);
  if (j.enc !== 1) throw new Error("not confidential intent");
  return decryptIntent(j.iv, j.ct, sharedSecret);
}

export function isConfIntent(intent: string): boolean {
  try { return JSON.parse(intent)?.enc === 1; } catch { return false; }
}
