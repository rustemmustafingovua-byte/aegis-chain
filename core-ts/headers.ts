/**
 * AEGIS Header Sync — light-client block header verification (v1.13)
 *
 * A light client should not trust a full node for balances OR for the chain
 * itself. This module lets it verify a run of headers without downloading
 * bodies:
 *   - height is consecutive, prevHash links hash-to-hash
 *   - each header hash recomputes to the advertised value
 *   - proposer is a known validator and the hybrid (Ed25519 + ML-DSA-65)
 *     signature over the header hash is valid
 *   - optionally: proposer matches the stake-weighted VRF for the slot
 *     (same function as Chain.proposerForSlot, computed from the previous
 *     block hash only — no state needed)
 *
 * Tx inclusion is then checked against `header.merkleRoot` with merkle.ts.
 */
import { headerHash, type BlockHeader } from "./chain.js";
import { hybridVerify } from "./hybrid.js";
import { sha256 } from "./crypto.js";

export type LightHeader = {
  header: BlockHeader;
  hash: string;
  signature: string; // base64 Ed25519 over header hash
  mlSignatureB64: string;
  mlPublicKeyB64: string;
};

export type ValidatorView = {
  publicKey: string;
  mlPublicKeyB64: string;
  stake: bigint;
  address?: string;
};

export type HeaderView = Map<string, ValidatorView>;

export function headerFromBlock(b: { header: BlockHeader; hash: string; signature: string; mlSignatureB64: string; mlPublicKeyB64: string }): LightHeader {
  return { header: b.header, hash: b.hash, signature: b.signature, mlSignatureB64: b.mlSignatureB64, mlPublicKeyB64: b.mlPublicKeyB64 };
}

/** Deterministic stake-weighted proposer for (slot, prevHash) — mirrors Chain.proposerForSlot. */
export function expectedProposer(slot: number, prevHash: string, validators: HeaderView): string | undefined {
  if (!validators.size) return undefined;
  const entries = [...validators.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const total = [...validators.values()].reduce((a, v) => a + (v.stake > 0n ? v.stake : 0n), 0n);
  if (total === 0n) return undefined;
  const seedHex = sha256(`aegis-slot:${slot}|${prevHash}`).slice(0, 16);
  const point = BigInt("0x" + seedHex) % total;
  const weights = entries.map(([, v]) => (v.stake > 0n ? v.stake : 1n));
  const wTotal = weights.reduce((a, b) => a + b, 0n);
  const scaled = wTotal > 0n ? (point * wTotal) / total : 0n;
  let acc = 0n;
  for (let i = 0; i < entries.length; i++) {
    acc += weights[i];
    if (scaled < acc) return entries[i][0];
  }
  return entries[entries.length - 1][0];
}

export type HeaderChainResult =
  | { ok: true; from: number; to: number; tips: string }
  | { ok: false; reason: string; atHeight?: number };

export type HeaderChainOpts = {
  /** Expected hash of the block immediately before headers[0] (e.g. a signed checkpoint hash). */
  expectedPrevHash?: string;
  /** Require headers[0].height === this. */
  expectedHeight?: number;
  /** Enforce stake-weighted proposer (needs real stakes in the view). Default true for >1 validator. */
  checkProposer?: boolean;
};

export function verifyHeaderChain(headers: LightHeader[], validators: HeaderView, opts: HeaderChainOpts = {}): HeaderChainResult {
  if (!headers.length) return { ok: false, reason: "empty header batch" };
  let prevHash = opts.expectedPrevHash;
  let prevHeight = opts.expectedHeight !== undefined ? opts.expectedHeight - 1 : headers[0].header.height - 1;
  for (let i = 0; i < headers.length; i++) {
    const lh = headers[i];
    const h = lh.header;
    if (h.height !== prevHeight + 1) return { ok: false, reason: `height gap: ${h.height} != ${prevHeight + 1}`, atHeight: h.height };
    if (prevHash !== undefined && h.prevHash !== prevHash) return { ok: false, reason: `prevHash mismatch at ${h.height}`, atHeight: h.height };
    const recomputed = headerHash(h);
    if (recomputed !== lh.hash) return { ok: false, reason: `header hash mismatch at ${h.height}`, atHeight: h.height };
    const v = validators.get(h.proposer);
    if (!v) return { ok: false, reason: `unknown proposer at ${h.height}`, atHeight: h.height };
    // hybrid signature over the header hash string (same message the node signs)
    const ok = hybridVerify(v.publicKey, Buffer.from(v.mlPublicKeyB64, "base64"), recomputed, {
      edSig: lh.signature,
      mlSig: lh.mlSignatureB64,
      hybrid: sha256(lh.signature + lh.mlSignatureB64),
    });
    if (!ok) return { ok: false, reason: `bad block signature at ${h.height}`, atHeight: h.height };
    const checkProposer = opts.checkProposer ?? validators.size > 1;
    if (checkProposer) {
      const expected = expectedProposer(h.slot, h.prevHash, validators);
      if (expected && expected !== h.proposer) return { ok: false, reason: `wrong proposer for slot at ${h.height}`, atHeight: h.height };
    }
    prevHash = lh.hash;
    prevHeight = h.height;
  }
  return { ok: true, from: headers[0].header.height, to: headers[headers.length - 1].header.height, tips: prevHash! };
}

/** Validator view from a full chain (full node helper; light clients get this from a checkpoint). */
export function validatorViewOf(chain: { validators: Map<string, { publicKey: string; mlPublicKeyB64: string; stake: bigint; address?: string }>; ledger: { accounts: Map<string, { stake: bigint }> } }): HeaderView {
  const out: HeaderView = new Map();
  for (const [pk, v] of chain.validators) {
    const ledgerStake = v.address ? (chain.ledger.accounts.get(v.address)?.stake ?? 0n) : 0n;
    out.set(pk, { publicKey: v.publicKey, mlPublicKeyB64: v.mlPublicKeyB64, stake: v.stake > 0n ? v.stake : ledgerStake, address: v.address });
  }
  return out;
}
