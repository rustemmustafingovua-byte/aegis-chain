/**
 * AEGIS crypto — adapted from Lumen
 * ed25519 (RFC 8032) via node:crypto, SHA-256, base58check address aeg1...
 */
import { createHash, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, createPrivateKey } from "node:crypto";

export type Keypair = { privateKey: string; publicKey: string };

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
export function sha256Buf(data: string | Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}
export function keypairFromSeed(seed: Buffer): Keypair {
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const pub = createPublicKey(key).export({ type: "spki", format: "der" }).subarray(12);
  return { privateKey: pkcs8.toString("base64"), publicKey: pub.toString("base64") };
}
export function generateKeypair(): Keypair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "der" },
    publicKeyEncoding: { type: "spki", format: "der" },
  });
  return { privateKey: privateKey.toString("base64"), publicKey: publicKey.toString("base64") };
}
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(data: Buffer): string {
  let n = BigInt("0x" + (data.toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    const rem = Number(n % 58n);
    n = n / 58n;
    out = B58[rem] + out;
  }
  for (const byte of data) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out || "1";
}
export function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let out = Buffer.from(hex, "hex");
  let zeros = 0;
  for (const ch of s) {
    if (ch !== "1") break;
    zeros++;
  }
  return Buffer.concat([Buffer.alloc(zeros), out]);
}
export function publicKeyBytes(publicKeyB64: string): Buffer {
  const raw = Buffer.from(publicKeyB64, "base64");
  return raw.length === 32 ? raw : raw.subarray(raw.length - 32);
}
export function addressFromPublicKey(publicKeyB64: string, prefix = "aeg"): string {
  const pub = publicKeyBytes(publicKeyB64);
  const body = Buffer.concat([Buffer.from([0x00]), pub]);
  const checksum = sha256Buf(
    sha256Buf(Buffer.concat([Buffer.from("aegis"), body])),
  ).subarray(0, 4);
  return prefix + base58(Buffer.concat([body, checksum]));
}
export function isValidAddress(address: string): boolean {
  if (!/^aeg1[1-9A-HJ-NP-Za-km-z]{32,60}$/.test(address)) return false;
  try {
    const raw = base58Decode(address.slice(3));
    if (raw.length !== 37) return false;
    const body = raw.subarray(0, 33);
    const checksum = raw.subarray(33);
    const expected = sha256Buf(
      sha256Buf(Buffer.concat([Buffer.from("aegis"), body])),
    ).subarray(0, 4);
    return checksum.equals(expected);
  } catch { return false; }
}
export function sign(privateKeyB64: string, message: Buffer | string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  const data = typeof message === "string" ? Buffer.from(message) : message;
  return edSign(null, data, key).toString("base64");
}
export function verify(publicKeyB64: string, message: Buffer | string, signatureB64: string): boolean {
  try {
    const pub = publicKeyBytes(publicKeyB64);
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub]);
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    const data = typeof message === "string" ? Buffer.from(message) : message;
    return edVerify(null, data, key, Buffer.from(signatureB64, "base64"));
  } catch { return false; }
}
export function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
