/**
 * AEGIS Wallet core (browser) — Ed25519 + ML-DSA-65 hybrid, intent-bound, mesh packets
 * Использует те же каноничные строки что core-ts в aegis-chain, чтобы подписи верифицировались сетью.
 */
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import * as ed from "@noble/ed25519";
import { createHash } from "node:crypto"; // fallback in browser — replaced by subtle

function sha256Hex(s: string): string {
  // sync via simple hash for demo (in prod: noble sha256)
  return bytesToHex(sha256(new TextEncoder().encode(s)));
}
function sha256Bytes(data: Uint8Array): string {
  return bytesToHex(sha256(data));
}

export type HybridKeypair = {
  edPrivate: Uint8Array; // 32 seed
  edPublic: Uint8Array; // 32
  mlSeed: Uint8Array; // 32
  mlSecretKey: Uint8Array;
  mlPublicKey: Uint8Array;
  address: string;
};

export function base58(data: Uint8Array): string {
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x" + (Buffer.from(data).toString("hex") || "0"));
  let out = "";
  while (n > 0n) { const r = Number(n % 58n); n = n / 58n; out = B58[r] + out; }
  for (const b of data) { if (b !== 0) break; out = "1" + out; }
  return out || "1";
}
export function addressFromEdPublic(edPub: Uint8Array): string {
  // aeg1 + base58(0x00 || pub || sha256(sha256("aegis"||body))[0:4])
  const body = new Uint8Array(33); body.set(edPub, 1);
  const domain = new TextEncoder().encode("aegis");
  const inner = new Uint8Array(domain.length + body.length); inner.set(domain, 0); inner.set(body, domain.length);
  const h1 = sha256(inner); const h2 = sha256(h1); const chk = h2.subarray(0, 4);
  const full = new Uint8Array(37); full.set(body, 0); full.set(chk, 33);
  return "aeg" + base58(full);
}

export function hybridGenerate(masterSeed?: Uint8Array): HybridKeypair {
  const seed = masterSeed ?? crypto.getRandomValues(new Uint8Array(32));
  const edPrivate = seed; // ed25519 seed
  void edPrivate;
  const edPublic = ed.getPublicKey(seed);
  const domain = new TextEncoder().encode("AEGIS/ML-DSA/seed/");
  const combined = new Uint8Array(domain.length + seed.length); combined.set(domain, 0); combined.set(seed, domain.length);
  const mlSeed = sha256(combined);
  const ml = ml_dsa65.keygen(mlSeed);
  return { edPrivate: seed, edPublic, mlSeed, mlSecretKey: ml.secretKey, mlPublicKey: ml.publicKey, address: addressFromEdPublic(edPublic) };
}

export function hybridSign(keys: HybridKeypair, msg: Uint8Array | string) {
  const data = typeof msg === "string" ? new TextEncoder().encode(msg) : msg;
  const edSig = ed.sign(data, keys.edPrivate);
  const mlSig = ml_dsa65.sign(data, keys.mlSecretKey);
  const hybrid = sha256Hex(bytesToHex(edSig) + Buffer.from(mlSig).toString("base64"));
  return { edSig: Buffer.from(edSig).toString("base64"), mlSig: Buffer.from(mlSig).toString("base64"), hybrid };
}
export function hybridVerify(edPub: Uint8Array, mlPub: Uint8Array, msg: Uint8Array | string, sig: { edSig: string; mlSig: string; hybrid: string }) {
  const data = typeof msg === "string" ? new TextEncoder().encode(msg) : msg;
  try {
    if (!ed.verify(Buffer.from(sig.edSig, "base64"), data, edPub)) return false;
    return ml_dsa65.verify(Buffer.from(sig.mlSig, "base64"), data, mlPub);
  } catch { return false; }
}

export function signIntent(keys: HybridKeypair, tx: { from: string; to: string; amount: string; intent: string; domain: string; expiry: number }, localEntropy: Uint8Array, lastBlockHash = "genesis") {
  const window = Math.floor(Date.now() / 1000 / 30);
  const challenge = sha256Hex(`${lastBlockHash}|${window}`);
  const hch = sha256Hex(challenge + "|" + bytesToHex(localEntropy));
  const full = { ...tx, humanContextHash: hch, nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(8))), timestamp: Date.now() };
  const canonical = [full.from, full.to, full.amount, full.intent, full.domain, full.expiry, full.humanContextHash, full.nonce].join("|");
  const sig = hybridSign(keys, canonical);
  return { ...full, sig, challenge, livenessResponse: hybridSign(keys, challenge + "|" + bytesToHex(localEntropy)), txHash: sha256Hex(canonical + "|" + sig.hybrid) };
}

export function offlinePacket(keys: HybridKeypair, from: string, to: string, amount: string, intent: string, domain: string, entropy: Uint8Array, height = 0, seq = 0) {
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
  const nullifier = bytesToHex(sha256(new TextEncoder().encode(bytesToHex(keys.mlSeed) + ":" + nonce)));
  const window = Math.floor(Date.now() / 1000 / 300);
  const challenge = sha256Hex(`OFFLINE|${height}|${window}`);
  const hch = sha256Hex(challenge + "|" + bytesToHex(entropy));
  const base = { from, to, amount, intent, domain, expiry: Math.floor(Date.now()/1000)+24*3600, humanContextHash: hch, nonce, nullifier, heightAtSync: height, balanceProofHash: sha256Hex("snap"+height), seq, mode: "OFFLINE" as const, ts: Date.now() };
  const canonical = [base.from, base.to, base.amount, base.intent, base.domain, base.expiry, base.humanContextHash, base.nonce, base.heightAtSync, base.balanceProofHash, base.seq].join("|");
  const sig = hybridSign(keys, canonical);
  const txHash = sha256Hex(canonical + "|" + sig.hybrid);
  return { ...base, sig, livenessChallenge: challenge, livenessResponse: hybridSign(keys, challenge + "|" + bytesToHex(entropy)), txHash, packetType: "AEGIS_PACKET" };
}

export function behavioralScore(intervals: number[], confirmMs: number, hch: string) {
  if (!intervals.length) return { score: 0, verdict: "blocked" as const, flags: ["no intervals"] };
  const mean = intervals.reduce((a,b)=>a+b,0)/intervals.length;
  const std = Math.sqrt(intervals.reduce((a,b)=>a+(b-mean)**2,0)/intervals.length);
  let score = 50; const flags: string[] = [];
  if (std > 300) { score+=25; flags.push("human-like variance"); } else if (std > 100) { score+=15; flags.push("moderate variance"); } else if (std < 20) { score-=30; flags.push("bot-like regular"); }
  if (confirmMs < 800) { score-=30; flags.push("too fast"); } else if (confirmMs > 3000) { score+=15; flags.push("thoughtful"); }
  score = Math.max(0, Math.min(100, score));
  return { score, verdict: score < 40 ? "blocked" : score < 70 ? "review" : "allow", flags, mean: Math.round(mean), std: Math.round(std) };
}
