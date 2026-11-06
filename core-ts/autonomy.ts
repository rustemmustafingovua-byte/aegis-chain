/**
 * AEGIS Autonomy — offline nullifier ledger
 * Каждый nonce = одноразовый nullifier. Двойная трата детектируется на синке.
 */
import { createHash, randomBytes } from "node:crypto";
import { sha256 } from "./crypto.js";
import { hybridSign, type HybridKeypair, type HybridSignature } from "./hybrid.js";

export type OfflineTx = {
  from: string;
  to: string;
  amount: bigint;
  intent: string;
  domain: string;
  expiry: number;
  humanContextHash: string;
  nonce: string;
  nullifier: string;
  heightAtSync: number;
  balanceProofHash: string;
  seq: number;
  mode: "OFFLINE";
  ts: number;
  sig: HybridSignature;
  livenessChallenge: string;
  livenessResponse: HybridSignature;
  txHash: string;
};

function sha256Hex(s: string) { return sha256(s); }
export function makeNullifier(privateSeed: Buffer, nonce: string): string {
  return createHash("sha256").update(privateSeed).update(":" + nonce).digest("hex");
}
export function canonicalOffline(tx: Omit<OfflineTx, "sig" | "livenessChallenge" | "livenessResponse" | "txHash">): string {
  return [tx.from, tx.to, tx.amount.toString(), tx.intent, tx.domain, tx.expiry, tx.humanContextHash, tx.nonce, tx.heightAtSync, tx.balanceProofHash, tx.seq].join("|");
}
export function offlineSign(keys: HybridKeypair, fromAddr: string, to: string, amount: bigint, intent: string, domain: string, localEntropy: Buffer, heightAtSync: number, balanceProofHash: string, seq: number): OfflineTx {
  if (!localEntropy || localEntropy.length < 8) throw new Error("local_entropy required");
  const nonce = randomBytes(8).toString("hex");
  const nullifier = makeNullifier(keys.mlSeed, nonce);
  const window = Math.floor(Date.now() / 1000 / 300);
  const challenge = sha256Hex(`OFFLINE|${heightAtSync}|${window}`);
  const humanContextHash = sha256Hex(challenge + "|" + localEntropy.toString("hex"));
  const base: Omit<OfflineTx, "sig" | "livenessChallenge" | "livenessResponse" | "txHash"> = {
    from: fromAddr, to, amount, intent, domain,
    expiry: Math.floor(Date.now() / 1000) + 24 * 3600,
    humanContextHash, nonce, nullifier, heightAtSync, balanceProofHash, seq, mode: "OFFLINE", ts: Date.now(),
  };
  const sig = hybridSign(keys, canonicalOffline(base));
  const livenessResponse = hybridSign(keys, challenge + "|" + localEntropy.toString("hex"));
  const txHash = sha256Hex(canonicalOffline(base) + "|" + sig.hybrid);
  return { ...base, sig, livenessChallenge: challenge, livenessResponse, txHash };
}
export function conflictResolve(a: OfflineTx, b: OfflineTx): { winner: OfflineTx; loser: OfflineTx } | null {
  if (a.nullifier !== b.nullifier) return null;
  return a.txHash < b.txHash ? { winner: a, loser: b } : { winner: b, loser: a };
}
