import test from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Chain } from "../core-ts/chain.js";
import { createRpcServer } from "../core-ts/rpc.js";
import { hybridGenerate, hybridSign, type HybridKeypair } from "../core-ts/hybrid.js";
import { createCheckpoint, coSign, verifyCheckpoint, CheckpointStore, checkpointMessage } from "../core-ts/checkpoints.js";
import { headerFromBlock, verifyHeaderChain, expectedProposer, validatorViewOf } from "../core-ts/headers.js";
import { verifyMerkleProof } from "../core-ts/merkle.js";
import { Wal, replayWal, walPaths } from "../core-ts/wal.js";

// ---------- helpers ----------
function mkChain(validators: HybridKeypair[], stake = 1000n) {
  const chain = new Chain();
  chain.genesis();
  for (const v of validators) {
    chain.ledger.fund(v.address, 100_000n);
    chain.ledger.get(v.address).edPublic = v.edPublic;
    chain.addValidator(v.edPublic, Buffer.from(v.mlPublicKey).toString("base64"), stake, v.address);
  }
  return chain;
}

function mine(chain: Chain, keys: HybridKeypair[], count: number, startSlot = 1) {
  const byEd = new Map(keys.map((k) => [k.edPublic, k]));
  let slot = startSlot;
  const blocks = [];
  for (let i = 0; i < count; i++) {
    const expected = chain.proposerForSlot(slot);
    const k = expected ? byEd.get(expected) : undefined;
    if (!k) { slot++; i--; continue; }
    blocks.push(chain.produceNextBlock(k, slot));
    slot++;
  }
  return blocks;
}

// ---------- checkpoints ----------
test("v1.13 checkpoint: single validator verify, tamper fails", () => {
  const v = hybridGenerate();
  const chain = mkChain([v]);
  mine(chain, [v], 2);
  const cp = createCheckpoint(chain, v);
  const view = validatorViewOf(chain);
  const ok = verifyCheckpoint(cp, view);
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.signedBps, 10000);

  const tampered = { ...cp, stateRoot: "0".repeat(64) };
  const bad = verifyCheckpoint(tampered, view);
  assert.equal(bad.ok, false);
  assert.equal(bad.signedBps, 0);

  // signature from a different key for the same height must not count
  const other = hybridGenerate();
  const forged = { ...cp, signatures: [{ validator: v.edPublic, sig: hybridSign(other, checkpointMessage(cp)) }] };
  assert.equal(verifyCheckpoint(forged, view).ok, false);
});

test("v1.13 checkpoint: 2/3 stake threshold with 3 validators", () => {
  const vs = [hybridGenerate(), hybridGenerate(), hybridGenerate()];
  const chain = mkChain(vs);
  mine(chain, vs, 1);
  const cp = createCheckpoint(chain, vs[0]);
  const view = validatorViewOf(chain);
  assert.equal(verifyCheckpoint(cp, view).ok, false); // 1/3
  coSign(cp, vs[1]);
  const v2 = verifyCheckpoint(cp, view);
  assert.equal(v2.ok, true, v2.reason); // 2/3
  assert.equal(v2.signedBps, 6667);
  // co-sign is idempotent
  coSign(cp, vs[1]);
  assert.equal(cp.signatures.length, 2);
});

test("v1.13 checkpoint store: merge, latest, list, roundtrip", () => {
  const v = hybridGenerate();
  const chain = mkChain([v]);
  mine(chain, [v], 1);
  const store = new CheckpointStore();
  const cp1 = createCheckpoint(chain, v);
  store.add(cp1);
  mine(chain, [v], 1, 2);
  const cp2 = createCheckpoint(chain, v);
  store.add(cp2);
  assert.equal(store.latest()?.height, cp2.height);
  assert.equal(store.list(0, 10).length, 2);
  const restored = CheckpointStore.fromJSON(JSON.parse(JSON.stringify(store.toJSON())));
  assert.equal(restored.latest()?.height, cp2.height);
  assert.equal(restored.latest()?.stateRoot, cp2.stateRoot);
});

// ---------- header sync ----------
test("v1.13 headers: verify chain, proposer VRF, tamper rejected", () => {
  const vs = [hybridGenerate(), hybridGenerate()];
  const chain = mkChain(vs);
  mine(chain, vs, 6);
  const headers = chain.blocks.filter((b) => b.header.height > 0).map(headerFromBlock);
  const view = validatorViewOf(chain);

  const ok = verifyHeaderChain(headers, view);
  assert.equal(ok.ok, true, (ok as any).reason);

  const cp = createCheckpoint(chain, vs[0]);
  const anchored = verifyHeaderChain(headers, view, { expectedPrevHash: chain.blocks[0].hash, expectedHeight: 1 });
  assert.equal(anchored.ok, true, (anchored as any).reason);
  void cp;

  // tamper: hash of one header
  const badHash = headers.map((h) => ({ ...h }));
  badHash[2].hash = "f".repeat(64);
  assert.equal(verifyHeaderChain(badHash, view).ok, false);

  // tamper: break the link
  const badLink = headers.map((h) => ({ ...h, header: { ...h.header } }));
  badLink[3].header.prevHash = "e".repeat(64);
  // hash no longer matches header either — either way it must fail
  assert.equal(verifyHeaderChain(badLink, view).ok, false);

  // wrong anchor
  assert.equal(verifyHeaderChain(headers, view, { expectedPrevHash: "a".repeat(64) }).ok, false);

  // expectedProposer parity with the chain for each header
  for (const h of headers) {
    assert.equal(expectedProposer(h.header.slot, h.header.prevHash, view), h.header.proposer);
  }
});

test("v1.13 headers: unknown proposer rejected", () => {
  const v = hybridGenerate();
  const chain = mkChain([v]);
  mine(chain, [v], 2);
  const headers = chain.blocks.filter((b) => b.header.height > 0).map(headerFromBlock);
  const view = validatorViewOf(chain);
  view.delete(headers[0].header.proposer);
  const res = verifyHeaderChain(headers, view);
  assert.equal(res.ok, false);
  assert.match((res as any).reason, /unknown proposer/);
});

// ---------- tx proof ----------
test("v1.13 rpc: aeg_getTxProof verifies tx inclusion in header merkleRoot", async () => {
  const v = hybridGenerate();
  const chain = mkChain([v]);
  // build a signed payment into the mempool
  const ts = Date.now();
  const msg = Buffer.from([v.address, v.address, "1000", "1000", 0, "test", "aegis.local", ts, ""].join("|"));
  const tx: any = {
    from: v.address, to: v.address, amount: 1000n, fee: 1000n, nonce: 0,
    intent: "test", domain: "aegis.local", timestamp: ts,
    sig: hybridSign(v, msg), mlPublicKeyB64: Buffer.from(v.mlPublicKey).toString("base64"), data: "",
  };
  chain.mempool.add(tx);
  const block = chain.produceNextBlock(v, 1);
  assert.equal(block.header.txCount, 1);

  const server = createRpcServer(chain);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  try {
    const call = async (method: string, params: any[]) => {
      const r = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return r.json() as any;
    };
    const res = await call("aeg_getTxProof", [block.header.height, 0]);
    assert.equal(res.result.proof.root, block.header.merkleRoot);
    assert.equal(verifyMerkleProof(res.result.proof), true);
    assert.equal(res.result.tx.from, v.address);

    const bad = res.result.proof;
    bad.leaf = "00".repeat(32);
    assert.equal(verifyMerkleProof(bad), false);

    const missing = await call("aeg_getTxProof", [block.header.height, 99]);
    assert.match(JSON.stringify(missing), /out of range/);

    const headers = await call("aeg_getHeaders", [0, 1000]);
    assert.match(JSON.stringify(headers), /range too large/);
  } finally { server.close(); }
});

// ---------- WAL replay ----------
test("v1.13 wal: replay restores blocks after the last snapshot, torn tail tolerated", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-wal-"));
  try {
    const stateFile = path.join(dir, "chain.json");
    const { walPath } = walPaths(stateFile);
    const v = hybridGenerate();
    const chain = mkChain([v]);
    chain.saveToFile(stateFile); // snapshot at height 0
    const wal = new Wal(walPath, stateFile);
    for (let i = 1; i <= 3; i++) wal.append(chain.produceNextBlock(v, i));
    const root = chain.ledger.stateRoot();
    assert.equal(chain.height, 3);

    const stale = Chain.loadFromFile(stateFile)!;
    assert.equal(stale.height, 0);
    const r = replayWal(stale, walPath);
    assert.equal(r.applied, 3);
    assert.equal(r.corrupt, false);
    assert.equal(stale.height, 3);
    assert.equal(stale.ledger.stateRoot(), root);

    // idempotent second replay
    const again = replayWal(stale, walPath);
    assert.equal(again.applied, 0);
    assert.equal(again.skipped, 3);

    // torn last line must not lose the valid prefix
    fs.appendFileSync(walPath, '{"header":{"height":4,"prevHa');
    const stale2 = Chain.loadFromFile(stateFile)!;
    const r2 = replayWal(stale2, walPath);
    assert.equal(r2.applied, 3);
    assert.equal(r2.corrupt, true);
    assert.equal(stale2.height, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("v1.13 checkpoint store: different timestamp is a new attestation, not a signature graft", () => {
  const v = hybridGenerate();
  const chain = mkChain([v]);
  mine(chain, [v], 1);
  const store = new CheckpointStore();
  const cp1 = createCheckpoint(chain, v);
  store.add(cp1);
  // same height/state/block, later timestamp → must replace, and its signature must verify
  const cp2 = { ...cp1, timestamp: cp1.timestamp + 1000, signatures: [] as any[] };
  coSign(cp2 as any, v);
  store.add(cp2 as any);
  const kept = store.at(cp1.height)!;
  assert.equal(kept.timestamp, cp2.timestamp);
  assert.equal(verifyCheckpoint(kept, validatorViewOf(chain)).ok, true);
});

test("v1.13 chain: empty heartbeat block advances height and replays from WAL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-hb-"));
  try {
    const stateFile = path.join(dir, "chain.json");
    const { walPath } = walPaths(stateFile);
    const v = hybridGenerate();
    const chain = mkChain([v]);
    chain.saveToFile(stateFile);
    const wal = new Wal(walPath, stateFile);
    for (let i = 1; i <= 2; i++) {
      assert.equal(chain.mempool.size, 0);
      const b = chain.produceNextBlock(v, i); // empty block = heartbeat
      assert.equal(b.header.txCount, 0);
      wal.append(b);
    }
    assert.equal(chain.height, 2);
    const reloaded = Chain.loadFromFile(stateFile)!;
    const r = replayWal(reloaded, walPath);
    assert.equal(r.applied, 2);
    assert.equal(reloaded.height, 2);
    assert.equal(reloaded.ledger.stateRoot(), chain.ledger.stateRoot());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("v1.13 rpc: aeg_checkpointSign persists through saveCheckpoints", async () => {
  const v = hybridGenerate();
  const chain = mkChain([v]);
  mine(chain, [v], 2);
  const store = new CheckpointStore();
  let saves = 0;
  const server = createRpcServer(chain, undefined, { checkpoints: store, validator: v, saveCheckpoints: () => { saves++; } });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "aeg_checkpointSign", params: [] }),
    }).then((r) => r.json()) as any;
    assert.equal(res.result.checkpoint.height, chain.height);
    assert.equal(res.result.verification.ok, true);
    assert.equal(store.latest()?.height, chain.height);
    assert.equal(saves, 1);
  } finally { server.close(); }
});
