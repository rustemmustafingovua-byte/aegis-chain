import test from "node:test";
import assert from "node:assert";
import { Chain } from "../core-ts/chain.js";
import { Ledger } from "../core-ts/ledger.js";
import { hybridGenerate } from "../core-ts/hybrid.js";
import { createRpcServer } from "../core-ts/rpc.js";
import {
  verifyNullifierProof, nullifierLeaf, parseNullifierLeaf, NULLIFIER_EMPTY_ROOT, type NullifierProof,
} from "../core-ts/nullifiers.js";
import { createCheckpoint, verifyCheckpoint, checkpointMessage, CheckpointStore } from "../core-ts/checkpoints.js";
import { merkleProof } from "../core-ts/merkle.js";
import { validatorViewOf } from "../core-ts/headers.js";

const N1 = "aa11" + "0".repeat(60);
const N2 = "bb22" + "0".repeat(60);
const N3 = "cc33" + "0".repeat(60);
const NX = "ab12" + "0".repeat(60); // between N1 and N2

// ---------- nullifier proofs ----------
test("v1.14 nullifier: non-inclusion proof verifies between neighbours", () => {
  const l = new Ledger();
  l.fund("aeg1a", 1000n);
  l.spentNullifiers.add(N1);
  l.spentNullifiers.add(N2);
  l.spentNullifiers.add(N3);

  const proof = l.nullifierProof(NX);
  assert.equal(proof.type, "non-inclusion");
  assert.equal(proof.root, l.nullifierRoot());
  const v = verifyNullifierProof(proof);
  assert.equal(v.ok, true, (v as any).reason);
  assert.equal((v as any).spent, false);
  // verified against the committed root from a checkpoint
  assert.equal(verifyNullifierProof(proof, l.nullifierRoot()).ok, true);
  // wrong anchor must fail
  assert.equal(verifyNullifierProof(proof, "0".repeat(64)).ok, false);
});

test("v1.14 nullifier: inclusion proof marks it spent", () => {
  const l = new Ledger();
  l.spentNullifiers.add(N1);
  l.spentNullifiers.add(N2);
  const proof = l.nullifierProof(N1);
  assert.equal(proof.type, "inclusion");
  const v = verifyNullifierProof(proof);
  assert.equal(v.ok, true, (v as any).reason);
  assert.equal((v as any).spent, true);
});

test("v1.14 nullifier: edges (before first / after last) and empty tree", () => {
  const l = new Ledger();
  assert.equal(l.nullifierRoot(), NULLIFIER_EMPTY_ROOT);
  const empty = l.nullifierProof(N1);
  assert.equal(empty.type, "non-inclusion");
  assert.equal(verifyNullifierProof(empty).ok, true);

  l.spentNullifiers.add(N2);
  const before = verifyNullifierProof(l.nullifierProof(N1));
  assert.equal(before.ok, true, (before as any).reason);
  const after = verifyNullifierProof(l.nullifierProof(N3));
  assert.equal(after.ok, true, (after as any).reason);

  // pretending the tree is empty while it is not must fail
  const fake: NullifierProof = { type: "non-inclusion", nullifier: N1, root: l.nullifierRoot(), left: null, right: null };
  assert.equal(verifyNullifierProof(fake).ok, false);
});

test("v1.14 nullifier: tampered neighbours / gaps are rejected", () => {
  const l = new Ledger();
  l.spentNullifiers.add(N1);
  l.spentNullifiers.add(N2);
  l.spentNullifiers.add(N3);
  const proof = l.nullifierProof(NX) as Extract<NullifierProof, { type: "non-inclusion" }>;

  // move the right neighbour to a non-adjacent leaf (still valid inclusion, but gap)
  const gap: NullifierProof = {
    ...proof,
    right: { leaf: nullifierLeaf(N3), proof: nullifierProofFor(l, N3) },
  };
  const gv = verifyNullifierProof(gap);
  assert.equal(gv.ok, false);
  assert.match((gv as any).reason, /adjacent|smaller|larger/);

  // claim the target itself is a neighbour (path is valid for N1, leaf says NX)
  const selfNeighbour: NullifierProof = { ...proof, left: { leaf: nullifierLeaf(NX), proof: proof.left!.proof } };
  assert.equal(verifyNullifierProof(selfNeighbour).ok, false);

  // swap the leaf value under a valid path
  const swapped: NullifierProof = { ...proof, left: { leaf: nullifierLeaf("0000" + "0".repeat(60)), proof: proof.left!.proof } };
  assert.equal(verifyNullifierProof(swapped).ok, false);
});

function nullifierProofFor(l: Ledger, n: string) {
  // helper: inclusion proof for an existing leaf (bypasses the spent check)
  const idx = l.nullifierLeaves().indexOf(nullifierLeaf(n));
  return merkleProof(l.nullifierLeaves(), idx);
}

test("v1.14 leaf helpers: canonical leaf round-trip", () => {
  assert.equal(nullifierLeaf("AB12"), "nullifier:ab12");
  assert.equal(parseNullifierLeaf("nullifier:ab12"), "ab12");
  assert.equal(parseNullifierLeaf("account:x"), null);
  assert.equal(parseNullifierLeaf("nullifier:"), null);
});

// ---------- state root / checkpoint anchoring ----------
test("v1.14 stateRoot commits the nullifier set", () => {
  const l = new Ledger();
  l.fund("aeg1a", 1000n);
  const before = l.stateRoot();
  assert.ok(l.stateLeaves().some((x) => x === `nullifiers:${l.nullifierRoot()}`));
  l.spentNullifiers.add(N1);
  assert.notEqual(l.stateRoot(), before);
  assert.ok(l.stateLeaves().includes(`nullifiers:${l.nullifierRoot()}`));
});

test("v1.14 checkpoint v2 anchors nullifierRoot; changing it breaks the signature", () => {
  const v = hybridGenerate();
  const chain = new Chain();
  chain.genesis();
  chain.ledger.fund(v.address, 100_000n);
  chain.ledger.get(v.address).edPublic = v.edPublic;
  chain.addValidator(v.edPublic, Buffer.from(v.mlPublicKey).toString("base64"), 1000n, v.address);
  chain.ledger.spentNullifiers.add(N1);
  const cp = createCheckpoint(chain, v);
  assert.equal(cp.version, 2);
  assert.equal(cp.nullifierRoot, chain.ledger.nullifierRoot());
  assert.equal(verifyCheckpoint(cp, validatorViewOf(chain)).ok, true);

  const other = { ...cp, nullifierRoot: NULLIFIER_EMPTY_ROOT };
  const bad = verifyCheckpoint(other, validatorViewOf(chain));
  assert.equal(bad.ok, false);
  assert.equal(bad.signedBps, 0);

  // v1 checkpoints cannot be trusted for offline proofs
  const legacy = { ...cp, version: 1 } as any;
  assert.equal(verifyCheckpoint(legacy, validatorViewOf(chain)).ok, false);
  const store = new CheckpointStore();
  store.add(legacy);
  assert.equal(store.latest(), null);
  // messages bind the nullifier root
  assert.ok(checkpointMessage(cp).toString().includes(cp.nullifierRoot));
});

// ---------- rpc ----------
test("v1.14 rpc: isNullifierSpent returns verified proof + checkpoint anchor", async () => {
  const v = hybridGenerate();
  const chain = new Chain();
  chain.genesis();
  chain.ledger.fund(v.address, 100_000n);
  chain.ledger.get(v.address).edPublic = v.edPublic;
  chain.addValidator(v.edPublic, Buffer.from(v.mlPublicKey).toString("base64"), 1000n, v.address);
  chain.ledger.spentNullifiers.add(N1);
  const checkpoints = new CheckpointStore();
  checkpoints.add(createCheckpoint(chain, v));

  const server = createRpcServer(chain, undefined, { checkpoints });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const call = async (method: string, params: any[]) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return r.json() as any;
  };
  try {
    const spent = await call("aeg_isNullifierSpent", [N1]);
    assert.equal(spent.result.spent, true);
    assert.equal(spent.result.verified, true);
    assert.equal(spent.result.proof.type, "inclusion");

    const fresh = await call("aeg_isNullifierSpent", [NX]);
    assert.equal(fresh.result.spent, false);
    assert.equal(fresh.result.verified, true);
    assert.equal(fresh.result.proof.type, "non-inclusion");
    assert.equal(fresh.result.anchor.nullifierRoot, chain.ledger.nullifierRoot());
    assert.equal(verifyNullifierProof(fresh.result.proof, fresh.result.anchor.nullifierRoot).ok, true);

    const state = await call("aeg_getState", []);
    assert.equal(state.result.nullifierRoot, chain.ledger.nullifierRoot());

    const root = await call("aeg_getNullifierRoot", []);
    assert.equal(root.result.nullifierRoot, chain.ledger.nullifierRoot());
  } finally { server.close(); }
});

// ---------- checkpoint pinning (rollback / fork detection) ----------
import { assessCheckpoint, strongerPin, type PinAnchor } from "../core-ts/pinning.js";

const anchor = (height: number, blockHash = "b".repeat(64), stateRoot = "s".repeat(64)): PinAnchor =>
  ({ height, blockHash, stateRoot });

test("v1.14 pinning: first contact pins, forward progress advances", () => {
  const first = assessCheckpoint(null, anchor(10));
  assert.equal(first.verdict, "pin");
  assert.equal(first.pin.height, 10);

  const same = assessCheckpoint(first.pin, anchor(10));
  assert.equal(same.verdict, "same");
  assert.equal(same.alerts.length, 0);

  const fwd = assessCheckpoint(first.pin, anchor(12));
  assert.equal(fwd.verdict, "advance");
  assert.equal(fwd.pin.height, 12);
});

test("v1.14 pinning: rollback keeps the higher pin and warns", () => {
  const pin = anchor(50);
  const res = assessCheckpoint(pin, anchor(47));
  assert.equal(res.verdict, "rollback");
  assert.equal(res.pin.height, 50, "must not lower the trusted pin");
  assert.equal(res.rollbackDepth, 3);
  assert.match(res.alerts[0], /rollback/);
});

test("v1.14 pinning: fork at the same height is detected and not overwritten", () => {
  const pin = anchor(80, "a".repeat(64));
  const res = assessCheckpoint(pin, anchor(80, "c".repeat(64)));
  assert.equal(res.verdict, "fork");
  assert.equal(res.pin.blockHash, pin.blockHash);
  assert.match(res.alerts[0], /fork detected/);

  // same block, different state root is also a fork
  assert.equal(assessCheckpoint(pin, anchor(80, pin.blockHash, "d".repeat(64))).verdict, "fork");
});

test("v1.14 pinning: gap beyond retention is flagged, strongerPin never regresses", () => {
  const res = assessCheckpoint(anchor(10), anchor(10 + 300), 256);
  assert.equal(res.verdict, "advance");
  assert.match(res.alerts[0], /large gap/);

  assert.equal(strongerPin(anchor(10), anchor(20))!.height, 20);
  assert.equal(strongerPin(anchor(20), anchor(5))!.height, 20);
  assert.equal(strongerPin(null, anchor(7))!.height, 7);
  assert.equal(strongerPin(anchor(7), null)!.height, 7);
});

test("v1.14 rpc: sendTx returns the real tx hash (message hash), not the state root", async () => {
  const v = hybridGenerate();
  const chain = new Chain();
  chain.genesis();
  chain.ledger.fund(v.address, 100_000_000n);
  chain.ledger.get(v.address).edPublic = v.edPublic;
  chain.addValidator(v.edPublic, Buffer.from(v.mlPublicKey).toString("base64"), 10_000n, v.address);
  const tx: any = {
    from: v.address, to: "aeg1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    amount: 1000n, fee: 1000n, nonce: 0, intent: "test", domain: "aegis.local", timestamp: Date.now(),
    sig: { edSig: "", mlSig: "", hybrid: "" }, mlPublicKeyB64: Buffer.from(v.mlPublicKey).toString("base64"),
    edPublicB64: v.edPublic, data: "",
  };
  const { hybridSign } = await import("../core-ts/hybrid.js");
  tx.sig = hybridSign(v, new Ledger().txMessage(tx));
  const server = createRpcServer(chain);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  try {
    const json = JSON.parse(JSON.stringify(tx, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
    const res = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "aeg_sendTx", params: [json] }),
    }).then((r) => r.json()) as any;
    assert.equal(res.result.accepted, true);
    const { sha256 } = await import("../core-ts/crypto.js");
    const { stringify } = await import("../core-ts/ledger.js");
    assert.equal(res.result.txHash, sha256(stringify(tx)).slice(0, 16));
    assert.notEqual(res.result.txHash, chain.ledger.stateRoot().slice(0, 16));
  } finally { server.close(); }
});
