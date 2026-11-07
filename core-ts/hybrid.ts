/**
 * AEGIS Hybrid signatures: Ed25519 + ML-DSA-65 (Dilithium3, FIPS 204)
 *
 * ML-DSA-65 is Category 3 (AES-192 equivalent), keys: pk 1952B, sk 4032B, sig 3309B.
 * For chain use we store ML-DSA public key on-chain (1952B — large, but acceptable for
 * trust layer; in L2 batched or via hash commitment: pubkey hash on-chain, full key off-chain).
 *
 * This module uses auditable @noble/post-quantum (ML-DSA-65 compatible).
 * Ed25519 is via node:crypto (same as Lumen).
 */
import { createHash, randomBytes } from "node:crypto";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { sign as edSign, verify as edVerify, sha256, sha256Buf, keypairFromSeed, addressFromPublicKey } from "./crypto.js";

export type HybridKeypair = {
  edPrivate: string; // base64 PKCS#8
  edPublic: string; // base64 spki der
  mlSeed: Buffer; // 32 bytes deterministic seed (to re-derive ML-DSA keys)
  mlSecretKey: Uint8Array;
  mlPublicKey: Uint8Array;
  address: string;
};

export type HybridSignature = {
  edSig: string; // base64
  mlSig: string; // base64
  hybrid: string; // sha256(edSig + mlSig) — binding
};

export function hybridGenerate(masterSeed?: Buffer): HybridKeypair {
  // ed25519 from seed (deterministic like Lumen) or random
  const seed = masterSeed ?? randomBytes(32);
  if (seed.length !== 32) throw new Error("seed 32 bytes");
  // ed keypair
  const ed = keypairFromSeed(seed);
  // ML-DSA seed: derive via hash domain separation so ed-seed != ml-seed collisions impossible
  const mlSeed = sha256Buf(Buffer.concat([Buffer.from("AEGIS/ML-DSA/seed/"), seed])).subarray(0, 32);
  const mlKeys = ml_dsa65.keygen(new Uint8Array(mlSeed));
  return {
    edPrivate: ed.privateKey,
    edPublic: ed.publicKey,
    mlSeed: Buffer.from(mlSeed),
    mlSecretKey: mlKeys.secretKey,
    mlPublicKey: mlKeys.publicKey,
    address: addressFromPublicKey(ed.publicKey, "aeg"),
  };
}

export function hybridSign(keys: HybridKeypair, msg: Buffer | string): HybridSignature {
  const data = typeof msg === "string" ? Buffer.from(msg) : msg;
  const edSig = edSign(keys.edPrivate, data);
  const mlSigBytes = ml_dsa65.sign(new Uint8Array(data), keys.mlSecretKey);
  const mlSig = Buffer.from(mlSigBytes).toString("base64");
  const hybrid = sha256(edSig + mlSig);
  return { edSig, mlSig, hybrid };
}

export function hybridVerify(edPublicB64: string, mlPublicKey: Uint8Array, msg: Buffer | string, sig: HybridSignature): boolean {
  const data = typeof msg === "string" ? Buffer.from(msg) : msg;
  // PQ size guards: reject truncated/oversized blobs before spending CPU (DoS guard)
  if (!(mlPublicKey instanceof Uint8Array) || mlPublicKey.length !== 1952) return false;
  try {
    if (Buffer.from(sig.edSig, "base64").length !== 64) return false;
    if (Buffer.from(sig.mlSig, "base64").length !== 3309) return false;
    if (typeof sig.hybrid !== "string" || sig.hybrid.length !== 64) return false;
  } catch { return false; }
  try { if (!edVerify(edPublicB64, data, sig.edSig)) return false; } catch { return false; }
  try {
    const mlSigBytes = Buffer.from(sig.mlSig, "base64");
    const ok = ml_dsa65.verify(mlSigBytes, new Uint8Array(data), mlPublicKey);
    if (!ok) return false;
  } catch { return false; }
  return sha256(sig.edSig + sig.mlSig) === sig.hybrid;
}

export function mlPublicKeyHash(mlPub: Uint8Array): string {
  return createHash("sha256").update(mlPub).digest("hex");
}
export function mlKeySizes() {
  return { publicKeyBytes: 1952, secretKeyBytes: 4032, sigBytes: 3309 };
}
export { ml_dsa65 };
