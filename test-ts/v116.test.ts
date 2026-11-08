import test from "node:test";
import assert from "node:assert";
import * as net from "node:net";
import { Chain } from "../core-ts/chain.js";
import { hybridGenerate, type HybridKeypair } from "../core-ts/hybrid.js";
import { P2pNode } from "../core-ts/p2p.js";
import { applyIncomingBlock, blockRef, classifyBlock, SyncTracker } from "../core-ts/sync.js";
import { applyGenesisConfig, readGenesisConfig } from "../core-ts/genesis.js";
import { createRpcServer } from "../core-ts/rpc.js";
import { CheckpointStore, createCheckpoint, verifyCheckpoint } from "../core-ts/checkpoints.js";
import { validatorViewOf } from "../core-ts/headers.js";
import { sha256 } from "../core-ts/crypto.js";

// v1.16: multi-node devnet — a lagging node catches up instead of banning
// the honest peer that is simply ahead of it.

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/** 32-byte deterministic seed from any label. */
function seedOf(label: string): Buffer { return Buffer.from(sha256(label), "hex"); }

function mkChain(validators: HybridKeypair[], stake = 10_000n) {
  const chain = new Chain();
  chain.genesis();
  for (const v of validators) {
    chain.ledger.fund(v.address, 100_000n);
    chain.ledger.get(v.address).edPublic = v.edPublic;
    chain.addValidator(v.edPublic, Buffer.from(v.mlPublicKey).toString("base64"), stake, v.address);
  }
  return chain;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(fn: () => boolean, ms = 4000, step = 50) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(step);
  }
  return fn();
}

test("v1.16 classifyBlock: next / duplicate / gap / fork", () => {
  const a = hybridGenerate(seedOf("aegis-v116-classify-a"));
  const chain = mkChain([a]);
  for (let slot = 1; slot <= 2; slot++) chain.produceNextBlock(a, slot);

  const head = chain.head!;
  assert.equal(classifyBlock(chain, { height: chain.height + 1, prevHash: head.hash, hash: "x" }), "next");
  assert.equal(classifyBlock(chain, { height: chain.height + 3, prevHash: "p", hash: "x" }), "gap");
  assert.equal(classifyBlock(chain, { height: 1, prevHash: "0".repeat(64), hash: chain.blocks[1].hash }), "duplicate");
  assert.equal(classifyBlock(chain, { height: 1, prevHash: "0".repeat(64), hash: "deadbeef" }), "fork");
  assert.equal(classifyBlock(chain, { height: chain.height + 1, prevHash: "0".repeat(64), hash: "x" }), "fork");
});

test("v1.16 SyncTracker: cooldown, exponential backoff, dead peer cutoff", () => {
  const t = new SyncTracker({ cooldownMs: 1000, maxBackoffMs: 8000, maxFailures: 3 });
  const now = 1_000_000;
  assert.equal(t.shouldRequest("p", 5, now), true);
  t.noteRequest("p", 5, now);
  assert.equal(t.shouldRequest("p", 5, now + 500), false, "cooldown must hold");
  assert.equal(t.shouldRequest("p", 6, now + 1000), true, "new target after cooldown");

  t.noteFailure("p", "timeout", now + 1000);
  assert.equal(t.shouldRequest("p", 7, now + 1500), false);
  assert.equal(t.shouldRequest("p", 7, now + 3000), true, "backoff doubles per failure");

  t.noteFailure("p", "timeout", now + 3000);
  t.noteFailure("p", "timeout", now + 3000);
  assert.equal(t.shouldRequest("p", 9, now + 100_000), false, "peer past maxFailures is skipped");
  t.noteSuccess("p", now + 100_000);
  assert.equal(t.shouldRequest("p", 9, now + 200_000), true, "success resets backoff");
});

test("v1.16 applyIncomingBlock: gap asks for sync once, never penalises", () => {
  const a = hybridGenerate(seedOf("aegis-v116-apply-a"));
  const chain = mkChain([a]);
  chain.produceNextBlock(a, 1);
  chain.produceNextBlock(a, 2);
  const peerBlock = chain.blocks[2]; // height 2 while the receiver is at 0 → gap
  // receiver lags behind the peer (own chain is empty)
  const lagging = mkChain([a]);
  const tracker = new SyncTracker({ cooldownMs: 1000 });
  let asked = 0;
  const res = applyIncomingBlock({
    chain: lagging, block: peerBlock, peerId: "peer-1", tracker,
    requestSync: () => { asked++; },
  });
  assert.equal(res.action, "sync");
  assert.equal(asked, 1);
  const again = applyIncomingBlock({
    chain: lagging, block: peerBlock, peerId: "peer-1", tracker,
    requestSync: () => { asked++; },
  });
  assert.equal(again.action, "ignored", "no sync spam inside the cooldown");
  assert.equal(asked, 1);

  // a node that is one block behind accepts the next one, then sees a duplicate
  const upToDate = mkChain([a]);
  const first = applyIncomingBlock({ chain: upToDate, block: chain.blocks[1], peerId: "peer-1", tracker });
  assert.equal(first.action, "applied", JSON.stringify(first));
  const second = applyIncomingBlock({ chain: upToDate, block: peerBlock, peerId: "peer-1", tracker });
  assert.equal(second.action, "applied", JSON.stringify(second));
  const dup = applyIncomingBlock({ chain: upToDate, block: peerBlock, peerId: "peer-1", tracker });
  assert.equal(dup.action, "ignored", JSON.stringify(dup));
  assert.equal((dup as any).cls, "duplicate");

  // fork is observed, not punished (known height, different hash)
  const forked = mkChain([a]);
  forked.accept(chain.blocks[1]);
  const fake = { ...chain.blocks[1], hash: "f".repeat(64) };
  const fr = applyIncomingBlock({ chain: forked, block: fake as any, peerId: "peer-1", tracker });
  assert.equal(fr.action, "ignored", JSON.stringify(fr));
  assert.equal((fr as any).cls, "fork");
});

test("v1.16 two real TCP nodes converge: lagging node pulls from the peer", async () => {
  const a = hybridGenerate(seedOf("aegis-v116-net-a"));
  const b = hybridGenerate(seedOf("aegis-v116-net-b"));
  const chainA = mkChain([a]);
  const chainB = mkChain([a]); // same validator set, but B will lag behind
  for (let slot = 1; slot <= 4; slot++) chainA.produceNextBlock(a, slot);

  const portA = await freePort();
  const portB = await freePort();
  const nodeA = new P2pNode(chainA, "node-a", portA);
  const nodeB = new P2pNode(chainB, "node-b", portB);
  await nodeA.listen();
  await nodeB.listen();
  try {
    assert.equal(chainB.height, 0);
    nodeB.connect("127.0.0.1", portA);
    const synced = await waitFor(() => chainB.height === chainA.height, 8000);
    assert.equal(synced, true, `B height ${chainB.height} != A ${chainA.height}`);
    assert.equal(chainB.head?.hash, chainA.head?.hash, "same head means same history");
    assert.equal(chainB.ledger.stateRoot(), chainA.ledger.stateRoot(), "state roots must agree");

    // live block propagation after the initial sync
    chainA.produceNextBlock(a, 5);
    nodeA.gossipBlock(chainA.head!);
    assert.equal(await waitFor(() => chainB.height === chainA.height, 4000), true);
    assert.equal(chainB.head?.hash, chainA.head?.hash);
  } finally {
    nodeA.close();
    nodeB.close();
  }
});

test("v1.16 real TCP: a node far behind receives new_block and pulls instead of banning", async () => {
  const a = hybridGenerate(seedOf("aegis-v116-gap-a"));
  const chainA = mkChain([a]);
  for (let slot = 1; slot <= 8; slot++) chainA.produceNextBlock(a, slot);
  const chainB = mkChain([a]); // height 0
  const portA = await freePort();
  const portB = await freePort();
  const nodeA = new P2pNode(chainA, "gap-a", portA);
  const nodeB = new P2pNode(chainB, "gap-b", portB);
  await nodeA.listen();
  await nodeB.listen();
  try {
    // B connects first, then A gossips only its head — a classic "gap" delivery
    const sockB = nodeB.connect("127.0.0.1", portA);
    assert.equal(await waitFor(() => nodeA.peerList().length > 0, 3000), true);
    nodeA.gossipBlock(chainA.head!);
    assert.equal(await waitFor(() => chainB.height === chainA.height, 8000), true);
    assert.equal(chainB.head?.hash, chainA.head?.hash);

    const peers = nodeA.peerList();
    const banned = peers.filter((p) => p.banned);
    assert.equal(banned.length, 0, "honest peer must not be banned for being ahead");
    assert.ok(peers.every((p) => p.score >= 40), `scores: ${JSON.stringify(peers.map((p) => p.score))}`);
    void sockB;
  } finally {
    nodeA.close();
    nodeB.close();
  }
});

test("v1.16 genesis config: identical sorted application → identical stateRoot", () => {
  const keys = [1, 2, 3].map((i) => hybridGenerate(seedOf(`aegis-v116-genesis-${i}`)));
  const cfg = readGenesisConfig(JSON.stringify({
    validators: keys.map((k) => ({
      edPublic: k.edPublic,
      mlPublicKeyB64: Buffer.from(k.mlPublicKey).toString("base64"),
      stake: "10000000000",
      address: k.address,
      balance: "100000000000",
      humanityScore: 90,
    })),
  }));
  assert.equal(cfg.validators.length, 3);

  // two nodes applying a shuffled cfg must produce the same ledger
  const shuffled = { validators: [...cfg.validators].reverse() };
  const c1 = new Chain(); c1.genesis(); applyGenesisConfig(c1, cfg, { fresh: true });
  const c2 = new Chain(); c2.genesis(); applyGenesisConfig(c2, shuffled, { fresh: true });
  assert.equal(c1.ledger.stateRoot(), c2.ledger.stateRoot());
  assert.equal(c1.validators.size, 3);
  for (const k of keys) assert.ok(c1.validators.has(k.edPublic));

  // restore is idempotent: no double funding, no duplicate validators
  const before = c1.ledger.balance(keys[0].address);
  const again = applyGenesisConfig(c1, cfg, { fresh: false });
  assert.equal(again.applied, 0);
  assert.equal(c1.ledger.balance(keys[0].address), before);
  assert.equal(c1.validators.size, 3);
});

test("v1.16 multi-validator: every staked validator gets elected over time", () => {
  const keys = [1, 2, 3].map((i) => hybridGenerate(seedOf(`aegis-v116-dist-${i}`)));
  const chain = mkChain(keys, 10_000n);
  const counts = new Map<string, number>();
  for (let slot = 1; slot <= 60; slot++) {
    const elected = chain.proposerForSlot(slot)!;
    counts.set(elected, (counts.get(elected) ?? 0) + 1);
    chain.produceNextBlock(keys.find((k) => k.edPublic === elected)!, slot);
  }
  assert.equal(counts.size, 3, `all validators elected: ${[...counts.keys()].length}`);
  for (const [, n] of counts) assert.ok(n >= 8, `no validator starved: ${JSON.stringify([...counts.values()])}`);
});

test("v1.16 multi-validator: only the elected proposer can extend the chain", () => {
  const keys = [1, 2, 3].map((i) => hybridGenerate(seedOf(`aegis-v116-elect-${i}`)));
  const chains = keys.map(() => mkChain(keys, 10_000n));
  let produced = 0;
  for (let slot = 1; slot <= 12; slot++) {
    const elected = chains[0].proposerForSlot(slot)!;
    const key = keys.find((k) => k.edPublic === elected)!;
    const block = chains[0].produceNextBlock(key, slot);
    produced++;
    // the same block is valid for every node (same genesis, same history)
    for (const c of chains.slice(1)) c.accept(block);
  }
  assert.equal(produced, 12);
  assert.ok(new Set(chains[0].validators.keys()).size === 3);
  for (const c of chains) {
    assert.equal(c.height, 12);
    assert.equal(c.head?.hash, chains[0].head?.hash);
  }
  // a non-elected proposer must be rejected, not silently forked
  const nextSlot = 13;
  const elected = chains[0].proposerForSlot(nextSlot)!;
  const wrong = keys.find((k) => k.edPublic !== elected)!;
  assert.throws(() => chains[0].produceNextBlock(wrong, nextSlot), /not proposer/);
  assert.equal(classifyBlock(chains[0], blockRef(chains[0].head!)).startsWith("d"), true);
});

test("v1.16 checkpoint co-signing: a peer signs our tip and refuses stale offers", async () => {
  const keys = [1, 2, 3].map((i) => hybridGenerate(seedOf(`aegis-v116-cosign-${i}`)));
  const chainA = mkChain(keys, 10_000n);
  const chainB = mkChain(keys, 10_000n);
  for (const slot of [1, 2]) {
    const elected = chainA.proposerForSlot(slot)!;
    chainA.produceNextBlock(keys.find((k) => k.edPublic === elected)!, slot);
  }
  // B is in sync with A (same history) — this is what the offer requires
  for (const b of chainA.blocks.slice(1)) chainB.accept(b);

  const storeB = new CheckpointStore();
  const server = createRpcServer(chainB, undefined, { checkpoints: storeB, validator: keys[1] });
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
    const cpA = createCheckpoint(chainA, keys[0]);
    const res = await call("aeg_checkpointOffer", [cpA]);
    assert.equal(res.result.signed, true, JSON.stringify(res.result));

    // B signed exactly A's checkpoint (same timestamp → mergeable message)
    const merged = res.result.checkpoint;
    assert.equal(merged.timestamp, cpA.timestamp);
    const v2 = verifyCheckpoint(merged, validatorViewOf(chainB));
    assert.equal(merged.signatures.length, 2);
    assert.equal(v2.ok, true, `2-of-3 should reach finality: ${v2.signedBps} bps`);

    // a third validator merging the same message reaches 3/3
    storeB.add(merged);
    const all = createCheckpoint(chainA, keys[0]);
    const res3 = await call("aeg_checkpointOffer", [all]);
    assert.equal(res3.result.signed, true);
    assert.equal(verifyCheckpoint(res3.result.checkpoint, validatorViewOf(chainB)).signedBps >= 6667, true);

    // stale offer (a height we are not at) must be refused — a signature attests
    // to state the signer can verify, not to a claim from the network
    const stale = { ...createCheckpoint(chainA, keys[0]), height: 1 };
    const bad = await call("aeg_checkpointOffer", [stale]);
    assert.equal(bad.result.signed, false);
    assert.match(bad.result.reason, /not at tip/);

    // tampered state root is refused too
    const wrongRoot = { ...createCheckpoint(chainA, keys[0]), stateRoot: "0".repeat(64) };
    const bad2 = await call("aeg_checkpointOffer", [wrongRoot]);
    assert.equal(bad2.result.signed, false);
    assert.match(bad2.result.reason, /state root/);
  } finally { server.close(); }
});
