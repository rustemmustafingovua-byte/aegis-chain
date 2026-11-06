/**
 * AEGIS Anti-AI Shield: Intent Binding + Liveness + Behavioral scoring
 */
import { createHash, randomBytes } from "node:crypto";
import { sha256 } from "./crypto.js";
import { hybridSign, hybridVerify, type HybridKeypair, type HybridSignature } from "./hybrid.js";

export type IntentTx = {
  from: string;
  to: string;
  amount: bigint;
  intent: string;
  domain: string;
  expiry: number; // unix seconds
  humanContextHash: string;
  nonce: string;
  timestamp: number;
};

export type SignedIntentTx = IntentTx & {
  sig: HybridSignature;
  livenessChallenge: string;
  livenessResponse: HybridSignature;
  txHash: string;
};

export function canonicalIntent(tx: IntentTx): string {
  return [tx.from, tx.to, tx.amount.toString(), tx.intent, tx.domain, tx.expiry, tx.humanContextHash, tx.nonce].join("|");
}
export function livenessChallenge(lastBlockHash: string, windowSec = 30): { challenge: string; window: number } {
  const window = Math.floor(Date.now() / 1000 / windowSec);
  const challenge = sha256(`${lastBlockHash}|${window}`);
  return { challenge, window };
}
export function signIntent(keys: HybridKeypair, tx: Omit<IntentTx, "humanContextHash" | "nonce" | "timestamp">, localEntropy: Buffer, lastBlockHash: string): SignedIntentTx {
  if (!localEntropy || localEntropy.length < 8) throw new Error("local_entropy required");
  const ch = livenessChallenge(lastBlockHash);
  const humanContextHash = sha256(ch.challenge + "|" + localEntropy.toString("hex"));
  const full: IntentTx = {
    ...tx,
    humanContextHash,
    nonce: randomBytes(8).toString("hex"),
    timestamp: Date.now(),
  };
  const sig = hybridSign(keys, canonicalIntent(full));
  const livenessResponse = hybridSign(keys, ch.challenge + "|" + localEntropy.toString("hex"));
  const txHash = sha256(canonicalIntent(full) + "|" + sig.hybrid);
  return { ...full, sig, livenessChallenge: ch.challenge, livenessResponse, txHash };
}
export function verifyIntent(edPublicB64: string, mlPublicKey: Uint8Array, tx: SignedIntentTx): { ok: boolean; reason: string } {
  if (tx.expiry * 1000 < Date.now()) return { ok: false, reason: "expired" };
  const msg = canonicalIntent(tx);
  if (!hybridVerify(edPublicB64, mlPublicKey, msg, tx.sig)) return { ok: false, reason: "hybrid sig mismatch (tampered intent/to/amount/domain?)" };
  if (tx.txHash !== sha256(msg + "|" + tx.sig.hybrid)) return { ok: false, reason: "tx hash mismatch" };
  return { ok: true, reason: "ok" };
}
export function behavioralScore(intervalsMs: number[], humanContextHash: string, confirmMs: number): { score: number; flags: string[]; mean: number; std: number; verdict: "allow" | "review" | "blocked" } {
  if (!intervalsMs.length) return { score: 0, flags: ["no intervals"], mean: 0, std: 0, verdict: "blocked" };
  const mean = intervalsMs.reduce((a, b) => a + b, 0) / intervalsMs.length;
  const varr = intervalsMs.reduce((a, b) => a + (b - mean) ** 2, 0) / intervalsMs.length;
  const std = Math.sqrt(varr);
  let score = 50;
  const flags: string[] = [];
  if (std > 300) { score += 25; flags.push("high variance (human-like)"); }
  else if (std > 100) { score += 15; flags.push("moderate variance"); }
  else if (std < 20) { score -= 30; flags.push("ultra-regular intervals (bot-like)"); }
  if (confirmMs < 800) { score -= 30; flags.push("confirm too fast (<800ms)"); }
  else if (confirmMs < 1500) { score -= 10; flags.push("fast confirm"); }
  else if (confirmMs > 3000) { score += 15; flags.push("thoughtful confirm"); }
  if (new Set(humanContextHash).size < 4) { score -= 10; flags.push("low-entropy human_context_hash"); }
  score = Math.max(0, Math.min(100, score));
  const verdict = score < 40 ? "blocked" : score < 70 ? "review" : "allow";
  return { score, flags, mean: Math.round(mean), std: Math.round(std), verdict };
}
export function ephemeralSessionKey(masterSecret: Buffer, sessionId: string, expiresIn = 60) {
  const now = Math.floor(Date.now() / 1000);
  const seed = createHash("sha256").update(masterSecret).update(":" + sessionId + now).digest();
  return { key: seed.toString("hex"), session_id: sessionId, iat: now, exp: now + expiresIn, maxAmount: 100 };
}
