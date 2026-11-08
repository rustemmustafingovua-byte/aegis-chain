/**
 * AEGIS Nullifier Proofs (v1.14) — «не потрачено» без полного узла.
 *
 * Зачем: офлайн-платёж в mesh приносит nullifier = H(ключ ‖ nonce). Получатель
 * офлайн не может спросить сеть «потрачен ли он», но может взять **подписанный
 * checkpoint** (stateRoot + nullifierRoot) и проверить:
 *   - inclusion     — nullifier уже в дереве (потрачен; платёж отклоняем),
 *   - non-inclusion — два соседних листа доказывают, что его нет в дереве.
 *
 * Дерево — обычное доменно-разделённое Merkle-дерево из merkle.ts, листья:
 *   `nullifier:<hex в нижнем регистре>`, отсортированы лексикографически.
 *
 * Non-inclusion proof — это два inclusion-proof'а соседей + проверка
 * left < n < right и того, что соседи **смежные** (right.index = left.index + 1).
 * Без проверки смежности можно было бы показать любые два листа и «доказать»
 * отсутствие того, что на самом деле есть между ними.
 */
import { sha256 } from "./crypto.js";
import { verifyMerkleProof, type MerkleProof } from "./merkle.js";

/** Root of an empty nullifier set — fixed verifiable constant, not a zero hash. */
export const NULLIFIER_EMPTY_ROOT = sha256("aegis-nullifiers-empty/v1");

export type NullifierProof =
  | { type: "inclusion"; nullifier: string; root: string; proof: MerkleProof }
  | {
      type: "non-inclusion"; nullifier: string; root: string;
      left: { leaf: string; proof: MerkleProof } | null;
      right: { leaf: string; proof: MerkleProof } | null;
    };

export type NullifierVerification =
  | { ok: true; spent: boolean; root: string; nullifier: string }
  | { ok: false; reason: string; root?: string; nullifier?: string };

const PREFIX = "nullifier:";

export function nullifierLeaf(nullifier: string): string {
  return `${PREFIX}${nullifier.toLowerCase()}`;
}

/** Extract the nullifier value from a canonical leaf, or null if malformed. */
export function parseNullifierLeaf(leaf: string): string | null {
  if (typeof leaf !== "string" || !leaf.startsWith(PREFIX)) return null;
  const v = leaf.slice(PREFIX.length);
  return v.length ? v.toLowerCase() : null;
}

/**
 * Verify a nullifier proof against its claimed root.
 * Callers MUST compare `res.root` (or pass `expectedRoot`) with the value from a
 * signed checkpoint / state root they already trust.
 */
export function verifyNullifierProof(proof: NullifierProof, expectedRoot?: string): NullifierVerification {
  if (!proof || typeof proof !== "object") return { ok: false, reason: "bad proof" };
  const n = String(proof.nullifier ?? "").toLowerCase();
  if (!n) return { ok: false, reason: "missing nullifier" };
  const root = String(proof.root ?? "");
  if (expectedRoot && root !== expectedRoot) {
    return { ok: false, reason: `root mismatch: ${root} != ${expectedRoot}`, root, nullifier: n };
  }

  if (proof.type === "inclusion") {
    if (!proof.proof || proof.proof.root !== root) return { ok: false, reason: "proof root mismatch", root, nullifier: n };
    if (proof.proof.leaf !== nullifierLeaf(n)) return { ok: false, reason: "leaf is not this nullifier", root, nullifier: n };
    if (!verifyMerkleProof(proof.proof)) return { ok: false, reason: "merkle path invalid", root, nullifier: n };
    return { ok: true, spent: true, root, nullifier: n };
  }

  if (proof.type !== "non-inclusion") {
    return { ok: false, reason: `unknown proof type: ${(proof as any).type}`, root, nullifier: n };
  }

  const left = proof.left, right = proof.right;
  if (!left && !right) {
    // empty tree: the only honest proof is that the root is the empty-set constant
    if (root !== NULLIFIER_EMPTY_ROOT) return { ok: false, reason: "empty proof for non-empty tree", root, nullifier: n };
    return { ok: true, spent: false, root, nullifier: n };
  }
  const target = nullifierLeaf(n);
  if (left) {
    const lv = parseNullifierLeaf(left.leaf);
    if (lv === null) return { ok: false, reason: "malformed left neighbour", root, nullifier: n };
    if (left.proof.root !== root) return { ok: false, reason: "left proof root mismatch", root, nullifier: n };
    if (left.proof.leaf !== left.leaf) return { ok: false, reason: "left leaf mismatch", root, nullifier: n };
    if (!verifyMerkleProof(left.proof)) return { ok: false, reason: "left merkle path invalid", root, nullifier: n };
    if (!(left.leaf < target)) return { ok: false, reason: "left neighbour is not smaller", root, nullifier: n };
  }
  if (right) {
    const rv = parseNullifierLeaf(right.leaf);
    if (rv === null) return { ok: false, reason: "malformed right neighbour", root, nullifier: n };
    if (right.proof.root !== root) return { ok: false, reason: "right proof root mismatch", root, nullifier: n };
    if (right.proof.leaf !== right.leaf) return { ok: false, reason: "right leaf mismatch", root, nullifier: n };
    if (!verifyMerkleProof(right.proof)) return { ok: false, reason: "right merkle path invalid", root, nullifier: n };
    if (!(target < right.leaf)) return { ok: false, reason: "right neighbour is not larger", root, nullifier: n };
    if (left && right.proof.index !== left.proof.index + 1) {
      return { ok: false, reason: "neighbours are not adjacent", root, nullifier: n };
    }
  }
  return { ok: true, spent: false, root, nullifier: n };
}
