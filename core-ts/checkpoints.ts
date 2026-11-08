/**
 * AEGIS Checkpoints — validator-signed state commitments (v1.13)
 *
 * Why: a light client that only syncs headers knows the chain history but not
 * whether a state root belongs to that history. A checkpoint is
 *   { height, stateRoot, blockHash, timestamp, signatures[] }
 * where validators sign `headerHash(height) + stateRoot`. With ≥ 2/3 of stake
 * signing, the checkpoint is as final as the chain itself (same finality rule).
 *
 * Fresh light client flow:
 *   1. get `aeg_checkpointLatest` (height N, stateRoot R, blockHash H)
 *   2. verify signatures against the validator set it trusts
 *   3. get headers N..N+k, verify links start at H (headers.ts)
 *   4. get `aeg_getProof` for an account, verify against stateRoot R
 *
 * No full node trust anywhere in that path.
 */
import { sha256 } from "./crypto.js";
import { hybridSign, hybridVerify, type HybridKeypair, type HybridSignature } from "./hybrid.js";
import type { HeaderView } from "./headers.js";

export type CheckpointSignature = { validator: string; sig: HybridSignature };
export type Checkpoint = {
  height: number;
  stateRoot: string;
  blockHash: string;
  timestamp: number;
  signatures: CheckpointSignature[];
};

export function checkpointMessage(cp: Pick<Checkpoint, "height" | "stateRoot" | "blockHash" | "timestamp">): Buffer {
  return Buffer.from(["aegis-checkpoint/v1", cp.height, cp.stateRoot, cp.blockHash, cp.timestamp].join("|"));
}

export type CheckpointSource = {
  height: number;
  ledger: { stateRoot(): string };
  head?: { hash: string };
};

export function createCheckpoint(chain: CheckpointSource, keys: HybridKeypair): Checkpoint {
  const cp: Checkpoint = {
    height: chain.height,
    stateRoot: chain.ledger.stateRoot(),
    blockHash: chain.head?.hash ?? "0".repeat(64),
    timestamp: Date.now(),
    signatures: [],
  };
  cp.signatures.push({ validator: keys.edPublic, sig: hybridSign(keys, checkpointMessage(cp)) });
  return cp;
}

/** Add/replace this validator's signature (idempotent by validator key). */
export function coSign(cp: Checkpoint, keys: HybridKeypair): Checkpoint {
  const msg = checkpointMessage(cp);
  const sig = hybridSign(keys, msg);
  const idx = cp.signatures.findIndex((s) => s.validator === keys.edPublic);
  if (idx >= 0) cp.signatures[idx] = { validator: keys.edPublic, sig };
  else cp.signatures.push({ validator: keys.edPublic, sig });
  return cp;
}

export type CheckpointVerification = {
  ok: boolean;
  signedStake: string;
  totalStake: string;
  signedBps: number;
  thresholdBps: number;
  signers: string[];
  reason?: string;
};

/**
 * Verify signatures and stake threshold. `validators` must be the set the client
 * trusts (from genesis config or a previous verified checkpoint).
 */
export function verifyCheckpoint(cp: Checkpoint, validators: HeaderView, thresholdBps = 6667): CheckpointVerification {
  const totalStake = [...validators.values()].reduce((a, v) => a + v.stake, 0n);
  const msg = checkpointMessage(cp);
  let signedStake = 0n;
  const signers: string[] = [];
  for (const s of cp.signatures) {
    const v = validators.get(s.validator);
    if (!v) continue;
    let ok = false;
    try {
      ok = hybridVerify(v.publicKey, Buffer.from(v.mlPublicKeyB64, "base64"), msg, s.sig);
    } catch { ok = false; }
    if (!ok) continue;
    signedStake += v.stake;
    signers.push(s.validator);
  }
  // round to nearest basis point so exactly 2/3 stake reports 6667, not 6666
  const signedBps = totalStake > 0n ? Number((signedStake * 10_000n + totalStake / 2n) / totalStake) : 0;
  const ok = totalStake > 0n && signedBps >= thresholdBps;
  return {
    ok,
    signedStake: signedStake.toString(),
    totalStake: totalStake.toString(),
    signedBps,
    thresholdBps,
    signers,
    reason: ok ? undefined : `insufficient stake: ${signedBps} bps < ${thresholdBps}`,
  };
}

export class CheckpointStore {
  map = new Map<number, Checkpoint>();
  keep = 256;

  add(cp: Checkpoint): void {
    const existing = this.map.get(cp.height);
    // merge signatures for the same height (multi-validator co-signing)
    // Merge only for the identical signed message. A different timestamp is a different
    // attestation, so it replaces the old one instead of grafting mismatched signatures.
    if (existing && existing.stateRoot === cp.stateRoot && existing.blockHash === cp.blockHash && existing.timestamp === cp.timestamp) {
      for (const s of cp.signatures) {
        const i = existing.signatures.findIndex((x) => x.validator === s.validator);
        if (i >= 0) existing.signatures[i] = s;
        else existing.signatures.push(s);
      }
    } else {
      this.map.set(cp.height, cp);
    }
    if (this.map.size > this.keep) {
      const heights = [...this.map.keys()].sort((a, b) => a - b);
      for (const h of heights.slice(0, this.map.size - this.keep)) this.map.delete(h);
    }
  }
  latest(): Checkpoint | null {
    if (!this.map.size) return null;
    return this.map.get(Math.max(...this.map.keys())) ?? null;
  }
  at(height: number): Checkpoint | null { return this.map.get(height) ?? null; }
  list(from = 0, limit = 50): Checkpoint[] {
    return [...this.map.values()].filter((c) => c.height >= from).sort((a, b) => a.height - b.height).slice(0, limit);
  }
  toJSON() { return { keep: this.keep, checkpoints: [...this.map.values()] }; }
  static fromJSON(j: any): CheckpointStore {
    const st = new CheckpointStore();
    if (j?.keep) st.keep = j.keep;
    for (const cp of j?.checkpoints ?? []) {
      try { if (typeof cp.height === "number") st.map.set(cp.height, cp); } catch { /* skip */ }
    }
    return st;
  }
}
