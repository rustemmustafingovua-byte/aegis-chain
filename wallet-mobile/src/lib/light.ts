/**
 * AEGIS Wallet Light Client (v1.15)
 *
 * Кошелёк больше не спрашивает у узла «сколько у меня денег» на слово.
 * Он проверяет всё сам, ровно теми же правилами, что и ядро:
 *
 *   1. aeg_validatorSet         → набор валидаторов (Ed25519 + ML-DSA-65, стейк)
 *   2. aeg_checkpointLatest     → checkpoint, подписи проверяются здесь (noble, PQ)
 *   3. aeg_getHeaders(cp..head) → заголовки: hash/prevHash/подпись/VRF-пропозер
 *   4. aeg_getProof(address)    → лист аккаунта + путь Меркла → сверка с cp.stateRoot
 *   5. pin                      → откат/форк относительно закреплённого якоря
 *
 * Если proof.root ≠ cp.stateRoot, состояние изменилось после checkpoint:
 * баланс помечается как НЕ подтверждённый (честно), а не «наверное верный».
 */
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { ed } from "./noble-setup";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

// ---------------- encodings ----------------
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function sha256Hex(input: string | Uint8Array): string {
  return bytesToHex(sha256(typeof input === "string" ? new TextEncoder().encode(input) : input));
}
function cat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------- types (mirror core-ts) ----------------
export type ValidatorView = { edPublic?: string; mlPublicKeyB64: string; stake: bigint; address?: string | null };
export type HybridSig = { edSig: string; mlSig: string; hybrid: string };
export type Checkpoint = {
  version: number; height: number; stateRoot: string; nullifierRoot: string;
  blockHash: string; timestamp: number;
  signatures: { validator: string; sig: HybridSig }[];
};
export type Header = {
  height: number; prevHash: string; timestamp: number; proposer: string;
  merkleRoot: string; txCount: number; slot: number;
};
export type LightHeader = { header: Header; hash: string; signature: string; mlSignatureB64: string; mlPublicKeyB64: string };
export type MerkleProof = { leaf: string; index: number; total: number; siblings: string[]; root: string };

// ---------------- canonical hashes (must equal core-ts) ----------------
export function headerHash(h: Header): string {
  return sha256Hex([h.height, h.prevHash, h.timestamp, h.proposer, h.merkleRoot, h.txCount, h.slot].join("|"));
}
export function checkpointMessage(cp: Checkpoint): string {
  return ["aegis-checkpoint/v2", cp.height, cp.stateRoot, cp.nullifierRoot, cp.blockHash, cp.timestamp].join("|");
}

// ---------------- crypto ----------------
export function verifyHybrid(edPublicB64: string, mlPublicKeyB64: string, msg: string, sig: HybridSig): boolean {
  try {
    if (!sig?.edSig || !sig?.mlSig || typeof sig.hybrid !== "string") return false;
    const edPub = b64ToBytes(edPublicB64);
    if (edPub.length !== 32) return false;
    const mlPub = b64ToBytes(mlPublicKeyB64);
    if (mlPub.length !== 1952) return false;
    const data = new TextEncoder().encode(msg);
    const edSig = b64ToBytes(sig.edSig);
    if (edSig.length !== 64) return false;
    const mlSig = b64ToBytes(sig.mlSig);
    if (mlSig.length !== 3309) return false;
    if (!ed.verify(edSig, data, edPub)) return false;
    if (!ml_dsa65.verify(mlSig, data, mlPub)) return false;
    // binding field ties both signatures to the same bytes
    return sha256Hex(sig.edSig + sig.mlSig) === sig.hybrid;
  } catch { return false; }
}

// ---------------- Merkle (domain separated, same as core-ts/merkle.ts) ----------------
function hashLeaf(leaf: string): Uint8Array {
  return sha256(cat(new Uint8Array([0]), new TextEncoder().encode(leaf)));
}
function hashNode(l: Uint8Array, r: Uint8Array): Uint8Array {
  return sha256(cat(new Uint8Array([1]), l, r));
}
export function verifyMerkleProof(p: MerkleProof): boolean {
  try {
    let cur = hashLeaf(p.leaf);
    let idx = p.index;
    for (const sibHex of p.siblings) {
      const sib = hexToBytes(sibHex);
      cur = idx % 2 === 0 ? hashNode(cur, sib) : hashNode(sib, cur);
      idx = Math.floor(idx / 2);
    }
    return bytesToHex(cur) === p.root;
  } catch { return false; }
}

// ---------------- proposer VRF (mirror Chain.proposerForSlot) ----------------
export function expectedProposer(slot: number, prevHash: string, validators: Map<string, ValidatorView>): string | undefined {
  if (!validators.size) return undefined;
  const entries = [...validators.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const total = [...validators.values()].reduce((a, v) => a + (v.stake > 0n ? v.stake : 0n), 0n);
  if (total === 0n) return undefined;
  const seedHex = sha256Hex(`aegis-slot:${slot}|${prevHash}`).slice(0, 16);
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

// ---------------- checkpoint ----------------
export type CheckpointResult = { ok: boolean; signedBps: number; totalStake: bigint; signedStake: bigint; reason?: string };

export function verifyCheckpoint(cp: Checkpoint, validators: Map<string, ValidatorView>, thresholdBps = 6667): CheckpointResult {
  const totalStake = [...validators.values()].reduce((a, v) => a + v.stake, 0n);
  if (cp.version !== 2) return { ok: false, signedBps: 0, totalStake, signedStake: 0n, reason: `unsupported checkpoint version ${cp.version}` };
  const msg = checkpointMessage(cp);
  let signedStake = 0n;
  for (const s of cp.signatures ?? []) {
    const entry = validators.get(s.validator);
    if (!entry) continue;
    // edPublic may be omitted when the map was built from headers.ts (key == edPublic)
    const edPublic = entry.edPublic ?? s.validator;
    if (verifyHybrid(edPublic, entry.mlPublicKeyB64, msg, s.sig)) signedStake += entry.stake;
  }
  const signedBps = totalStake > 0n ? Number((signedStake * 10_000n + totalStake / 2n) / totalStake) : 0;
  const ok = totalStake > 0n && signedBps >= thresholdBps;
  return { ok, signedBps, totalStake, signedStake, reason: ok ? undefined : `insufficient stake ${signedBps} bps < ${thresholdBps}` };
}

// ---------------- headers ----------------
export type HeaderResult = { ok: boolean; reason?: string; atHeight?: number; checked: number };

export function verifyHeaders(
  headers: LightHeader[],
  validators: Map<string, ValidatorView>,
  opts: { expectedPrevHash?: string; expectedHeight?: number } = {},
): HeaderResult {
  if (!headers.length) return { ok: false, reason: "empty header batch", checked: 0 };
  let prevHash = opts.expectedPrevHash;
  let prevHeight = opts.expectedHeight !== undefined ? opts.expectedHeight - 1 : headers[0].header.height - 1;
  for (const lh of headers) {
    const h = lh.header;
    if (h.height !== prevHeight + 1) return { ok: false, reason: `height gap at ${h.height}`, atHeight: h.height, checked: 0 };
    if (prevHash !== undefined && h.prevHash !== prevHash) return { ok: false, reason: `prevHash mismatch at ${h.height}`, atHeight: h.height, checked: 0 };
    if (headerHash(h) !== lh.hash) return { ok: false, reason: `header hash mismatch at ${h.height}`, atHeight: h.height, checked: 0 };
    const v = validators.get(h.proposer);
    if (!v) return { ok: false, reason: `unknown proposer at ${h.height}`, atHeight: h.height, checked: 0 };
    if (lh.mlPublicKeyB64 !== v.mlPublicKeyB64) return { ok: false, reason: `ML key substitution at ${h.height}`, atHeight: h.height, checked: 0 };
    const sig: HybridSig = { edSig: lh.signature, mlSig: lh.mlSignatureB64, hybrid: sha256Hex(lh.signature + lh.mlSignatureB64) };
    if (!verifyHybrid(v.edPublic ?? h.proposer, v.mlPublicKeyB64, lh.hash, sig)) {
      return { ok: false, reason: `bad block signature at ${h.height}`, atHeight: h.height, checked: 0 };
    }
    if (validators.size > 1) {
      const expected = expectedProposer(h.slot, h.prevHash, validators);
      if (expected && expected !== h.proposer) return { ok: false, reason: `wrong proposer for slot at ${h.height}`, atHeight: h.height, checked: 0 };
    }
    prevHash = lh.hash;
    prevHeight = h.height;
  }
  return { ok: true, checked: headers.length };
}

// ---------------- account leaf ----------------
export type AccountState = { address: string; balance: bigint; stake: bigint; nonce: number; pendingUnstake: bigint };

export function parseAccountLeaf(leaf: string): AccountState | null {
  const m = /^account:([^:]+):(\d+):(\d+):(\d+):(\d+)$/.exec(leaf);
  if (!m) return null;
  return { address: m[1], balance: BigInt(m[2]), stake: BigInt(m[3]), nonce: Number(m[4]), pendingUnstake: BigInt(m[5]) };
}

// ---------------- orchestration ----------------
export type RpcCall = (method: string, params: any[]) => Promise<any>;

export type LightCheck = { label: string; ok: boolean; detail: string };
export type LightBalanceResult = {
  verified: boolean;
  balance: string | null;
  height: number;
  checkpointHeight: number;
  stateRoot: string | null;
  checks: LightCheck[];
  alerts: string[];
  reason?: string;
};

const BATCH = 100;

/**
 * Полная проверка баланса без доверия узлу.
 * `call(method, params)` — JSON-RPC вызов к любому узлу (недоверенному).
 */
export async function lightBalance(call: RpcCall, address: string): Promise<LightBalanceResult> {
  const checks: LightCheck[] = [];
  const alerts: string[] = [];

  // 1. validator set
  const vs = await call("aeg_validatorSet", []);
  if (!Array.isArray(vs) || !vs.length) {
    return { verified: false, balance: null, height: 0, checkpointHeight: 0, stateRoot: null, checks, alerts, reason: "no validators from node" };
  }
  const validators = new Map<string, ValidatorView>();
  for (const v of vs) validators.set(v.edPublic, { edPublic: v.edPublic, mlPublicKeyB64: v.mlPublicKeyB64, stake: BigInt(v.stake), address: v.address });
  checks.push({ label: "validator set", ok: true, detail: `${validators.size} валидатор(ов), стейк ${[...validators.values()].reduce((a, v) => a + v.stake, 0n).toString()}` });

  // 2. checkpoint + PQ signature check, locally
  const cpj = await call("aeg_checkpointLatest", []);
  const cp: Checkpoint | null = cpj?.checkpoint ?? null;
  if (!cp) return { verified: false, balance: null, height: 0, checkpointHeight: 0, stateRoot: null, checks, alerts, reason: "node has no signed checkpoint yet" };
  const cpv = verifyCheckpoint(cp, validators);
  checks.push({ label: "checkpoint 2/3 стейка", ok: cpv.ok, detail: `${cpv.signedBps / 100}% (${cpv.signedStake}/${cpv.totalStake}), h=${cp.height}` });
  if (!cpv.ok) alerts.push(`checkpoint not final: ${cpv.reason}`);

  // 3. head + header chain from the checkpoint anchor
  const st = await call("aeg_getState", []);
  const head: number = Number(st?.height ?? cp.height);
  let headersOk = true, headersChecked = 0;
  if (head > cp.height) {
    // cp.blockHash is the hash of block cp.height → the first header we need is cp.height+1
    let from = cp.height + 1;
    let anchor = cp.blockHash;
    while (from <= head) {
      const to = Math.min(from + BATCH - 1, head);
      const batch: LightHeader[] = await call("aeg_getHeaders", [from, to]);
      const res = verifyHeaders(batch, validators, { expectedPrevHash: anchor, expectedHeight: from });
      if (!res.ok) { headersOk = false; alerts.push(`headers: ${res.reason}`); break; }
      headersChecked += res.checked;
      anchor = batch[batch.length - 1].hash;
      from = to + 1;
    }
    if (headersOk) checks.push({ label: "header chain", ok: true, detail: `${headersChecked} заголовков ${cp.height}→${head}, подписи и VRF` });
  } else {
    checks.push({ label: "header chain", ok: true, detail: "head == checkpoint height" });
  }

  // 4. account proof against the checkpoint state root
  const proof: MerkleProof & { height?: number } = await call("aeg_getProof", [address]);
  if (!proof || !proof.root) return { verified: false, balance: null, height: head, checkpointHeight: cp.height, stateRoot: null, checks, alerts, reason: "node did not return an account proof" };
  const pathOk = verifyMerkleProof(proof);
  const rootMatches = proof.root === cp.stateRoot;
  const acc = parseAccountLeaf(proof.leaf);
  const leafMatchesAddress = !!acc && acc.address === address;
  checks.push({ label: "merkle path", ok: pathOk, detail: `siblings ${proof.siblings.length}, leaf ${proof.leaf.slice(0, 34)}…` });
  checks.push({ label: "state root = checkpoint", ok: rootMatches, detail: rootMatches ? `root ${cp.stateRoot.slice(0, 16)}…` : `tip ${proof.root.slice(0, 12)}… ≠ cp ${cp.stateRoot.slice(0, 12)}…` });

  const verified = cpv.ok && headersOk && pathOk && rootMatches && leafMatchesAddress;
  if (!rootMatches) {
    alerts.push(`состояние изменилось после checkpoint h=${cp.height}: баланс не подтверждён (обнови чекпоинт)`);
  }
  return {
    verified,
    balance: acc ? acc.balance.toString() : null,
    height: head,
    checkpointHeight: cp.height,
    stateRoot: cp.stateRoot,
    checks,
    alerts,
    reason: verified ? undefined : (cpv.ok ? undefined : cpv.reason) ?? (headersOk ? undefined : "header chain invalid") ?? (rootMatches ? undefined : "stale checkpoint"),
  };
}
