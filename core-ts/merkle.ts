/**
 * AEGIS Merkle v1.12 — domain-separated Merkle tree with inclusion proofs.
 *
 * Used by:
 *  - block tx commitments (chain.ts)
 *  - ledger state commitments + light-client account proofs (ledger.ts / proofs)
 *
 * Design notes:
 *  - leaf hash = H(0x00 || leaf)
 *  - node hash = H(0x01 || left || right)
 *  - odd level duplicates the last node (Bitcoin-style, simple & auditable)
 *  - domain separation prevents second-preimage attacks where a leaf could be
 *    interpreted as an internal node.
 */
import { createHash } from "node:crypto";

const LEAF = Buffer.from([0x00]);
const NODE = Buffer.from([0x01]);

function h(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

export function hashLeaf(leaf: string | Buffer): Buffer {
  return h(Buffer.concat([LEAF, typeof leaf === "string" ? Buffer.from(leaf) : leaf]));
}

export function hashNode(left: Buffer, right: Buffer): Buffer {
  return h(Buffer.concat([NODE, left, right]));
}

export type MerkleProof = {
  leaf: string;
  index: number;
  total: number;
  siblings: string[]; // hex, bottom-up
  root: string; // hex
};

function buildLevels(leaves: string[]): Buffer[][] {
  if (leaves.length === 0) return [[hashLeaf("")]];
  let level = leaves.map(hashLeaf);
  const levels: Buffer[][] = [level];
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? level[i];
      next.push(hashNode(left, right));
    }
    level = next;
    levels.push(level);
  }
  return levels;
}

export function merkleRoot(leaves: string[]): string {
  const levels = buildLevels(leaves);
  return levels[levels.length - 1][0].toString("hex");
}

/** Inclusion proof for leaves[index]. Index is taken modulo the (padded) leaf count. */
export function merkleProof(leaves: string[], index: number): MerkleProof {
  if (leaves.length === 0) throw new Error("empty tree");
  if (index < 0 || index >= leaves.length) throw new Error("index out of range");
  const levels = buildLevels(leaves);
  const siblings: string[] = [];
  let idx = index;
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l];
    const sibIdx = idx % 2 === 0 ? Math.min(idx + 1, level.length - 1) : idx - 1;
    siblings.push(level[sibIdx].toString("hex"));
    idx = Math.floor(idx / 2);
  }
  return { leaf: leaves[index], index, total: leaves.length, siblings, root: levels[levels.length - 1][0].toString("hex") };
}

export function verifyMerkleProof(proof: MerkleProof): boolean {
  let cur = hashLeaf(proof.leaf);
  let idx = proof.index;
  for (const sibHex of proof.siblings) {
    const sib = Buffer.from(sibHex, "hex");
    cur = idx % 2 === 0 ? hashNode(cur, sib) : hashNode(sib, cur);
    idx = Math.floor(idx / 2);
  }
  return cur.toString("hex") === proof.root;
}

/** Root of every leaf's hash (block tx commitment: leaves are sha256(tx) hex strings). */
export function merkleRootOfHashedLeaves(hashedLeaves: string[]): string {
  return merkleRoot(hashedLeaves);
}
