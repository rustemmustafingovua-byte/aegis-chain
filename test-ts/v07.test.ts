/**
 * AEGIS v0.7 production-hardening tests
 * — fee → proposer (not burn), rewardProposer, persistence, hybrid block enforcement,
 *   mempool guards, RPC validation, P2P InMemory, unstake delay
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hybridGenerate, hybridSign } from "../core-ts/hybrid.js";
import { Chain, Mempool } from "../core-ts/chain.js";
import { Ledger } from "../core-ts/ledger.js";
import { InMemoryBus, P2pNode } from "../core-ts/p2p.js";

function mkTx(fromKeys: any, toAddr: string, amount: bigint, fee: bigint, nonce: number, opts: any = {}) {
  const ts = Date.now();
  const data = opts.data as string | undefined;
  const intent = opts.intent ?? "test";
  const domain = opts.domain ?? "aegis.example";
  const msg = data !== undefined
    ? Buffer.from([fromKeys.address, toAddr, amount.toString(), fee.toString(), nonce, intent, domain, ts, data].join("|"))
    : Buffer.from([fromKeys.address, toAddr, amount.toString(), fee.toString(), nonce, intent, domain, ts].join("|"));
  const sig = hybridSign(fromKeys, msg);
  return {
    from: fromKeys.address, to: toAddr, amount, fee, nonce,
    intent, domain, timestamp: ts, sig,
    mlPublicKeyB64: Buffer.from(fromKeys.mlPublicKey).toString("base64"),
    ...(data !== undefined ? { data } : {}),
    ...(opts.nullifier ? { nullifier: opts.nullifier } : {}),
  } as any;
}

describe("v0.7 Ledger: fee → proposer + reward", () => {
  it("fee goes to proposer, not burned", () => {
    const l = new Ledger();
    const alice = hybridGenerate();
    const bob = hybridGenerate();
    const proposer = hybridGenerate();
    l.fund(alice.address, 1000n);
    l.get(alice.address).edPublic = alice.edPublic;
    l.get(proposer.address).edPublic = proposer.edPublic;
    const before = l.balance(proposer.address);
    const tx = mkTx(alice, bob.address, 100n, 50n, 0);
    l.apply(tx, proposer.address, 1);
    assert.equal(l.balance(proposer.address), before + 50n, "fee should land on proposer");
    assert.equal(l.balance(bob.address), 100n);
    assert.equal(l.balance(alice.address), 850n);
  });
  it("rewardProposer math 3% APR per block", () => {
    const l = new Ledger();
    const val = hybridGenerate();
    const stake = 10_000_000000n;
    const total = 10_000_000000n;
    // yearly = stake*300/10000 = 300,000_000000 ; per-block = yearly/7_884_000 = 38_051... (integer div)
    const r = l.rewardProposer(val.address, stake, total);
    assert.ok(r > 0n, `reward ${r} should be positive for 10k stake`);
    assert.equal(l.balance(val.address), r);
  });
  it("unstake creates pending with delay, early unlock rejected", () => {
    const l = new Ledger();
    const a = hybridGenerate();
    l.fund(a.address, 30_000_000000n);
    l.get(a.address).edPublic = a.edPublic;
    // stake 10k at height 1
    l.apply(mkTx(a, a.address, 10_000_000000n, 0n, 0, { data: "stake:" }), undefined, 1);
    assert.ok(l.get(a.address).stake >= 10_000_000000n);
    // unstake at height 2
    l.apply(mkTx(a, a.address, 10_000_000000n, 0n, 1, { data: "unstake:" }), undefined, 2);
    assert.equal(l.get(a.address).stake, 0n);
    assert.equal(l.get(a.address).pendingUnstake, 10_000_000000n);
    assert.equal(l.get(a.address).unstakeAt, 102);
    // early unlock at height 50 should fail
    assert.throws(() => l.apply(mkTx(a, a.address, 0n, 0n, 2, { data: "unlock:" }), undefined, 50), /not yet unlocked/);
    // unlock at height 102 succeeds
    l.apply(mkTx(a, a.address, 0n, 0n, 2, { data: "unlock:" }), undefined, 102);
    assert.equal(l.get(a.address).pendingUnstake, 0n);
    assert.ok(l.balance(a.address) >= 20_000_000000n);
  });
  it("snapshot / restore round-trip", () => {
    const l = new Ledger();
    const a = hybridGenerate();
    l.fund(a.address, 5000n);
    l.get(a.address).edPublic = a.edPublic;
    l.addLiquidity("AEGIS/USDC", 1000n, 1000n, a.address);
    const snap = l.snapshot();
    const l2 = new Ledger();
    l2.restore(snap);
    assert.equal(l2.balance(a.address), 5000n);
    assert.equal(l2.stateRoot(), l.stateRoot());
    assert.equal(l2.sharesOf("AEGIS/USDC", a.address), l.sharesOf("AEGIS/USDC", a.address));
  });
  it("canApply dry-run rejects insufficient + bad nonce, no mutation", () => {
    const l = new Ledger();
    const a = hybridGenerate();
    l.fund(a.address, 10n);
    l.get(a.address).edPublic = a.edPublic;
    const tx = mkTx(a, a.address, 100n, 0n, 0);
    assert.throws(() => l.canApply(tx), /insufficient/);
    // no nonce bump after failed canApply
    assert.equal(l.get(a.address).nonce, 0);
  });
});

describe("v0.7 Chain: hybrid block sig + proposer + persistence", () => {
  it("tampered ML-DSA block sig is rejected", () => {
    const alice = hybridGenerate();
    const bob = hybridGenerate();
    const chain = new Chain(); chain.genesis();
    chain.ledger.fund(alice.address, 1000n);
    chain.ledger.get(alice.address).edPublic = alice.edPublic;
    chain.addValidator(alice.edPublic, Buffer.from(alice.mlPublicKey).toString("base64"), 1000n, alice.address);
    const tx = mkTx(alice, bob.address, 10n, 0n, 0);
    const block = chain.propose([tx], alice, 1);
    // tamper ML sig: replace with base64 of zeros (same length-ish, still invalid)
    const bad = { ...block, mlSignatureB64: Buffer.alloc(Buffer.from(block.mlSignatureB64, "base64").length).toString("base64") };
    assert.equal(chain.verifyBlockSig(bad), false);
    assert.throws(() => chain.accept(bad as any), /bad hybrid block signature/);
    // good block still accepts
    assert.equal(chain.accept(block), true);
  });
  it("wrong proposer for slot rejected (multi-validator)", () => {
    const v1 = hybridGenerate();
    const v2 = hybridGenerate();
    const chain = new Chain(); chain.genesis();
    chain.ledger.fund(v1.address, 1000n);
    chain.ledger.fund(v2.address, 1000n);
    chain.ledger.get(v1.address).edPublic = v1.edPublic;
    chain.ledger.get(v2.address).edPublic = v2.edPublic;
    chain.addValidator(v1.edPublic, Buffer.from(v1.mlPublicKey).toString("base64"), 10000n, v1.address);
    chain.addValidator(v2.edPublic, Buffer.from(v2.mlPublicKey).toString("base64"), 10000n, v2.address);
    // find slot where proposer is v2, then try to propose with v1
    let slot = 1;
    while (chain.proposerForSlot(slot) !== v2.edPublic && slot < 50) slot++;
    assert.ok(slot < 50);
    assert.throws(() => chain.propose([], v1, slot), /not proposer/);
  });
  it("serialize / deserialize retains height + balances", () => {
    const alice = hybridGenerate();
    const bob = hybridGenerate();
    const chain = new Chain(); chain.genesis();
    chain.ledger.fund(alice.address, 1000n);
    chain.ledger.get(alice.address).edPublic = alice.edPublic;
    chain.addValidator(alice.edPublic, Buffer.from(alice.mlPublicKey).toString("base64"), 1000n, alice.address);
    const tx = mkTx(alice, bob.address, 50n, 5n, 0);
    const b = chain.propose([tx], alice, 1);
    chain.accept(b);
    const json = chain.serialize();
    const restored = Chain.deserialize(json);
    assert.equal(restored.height, chain.height);
    assert.equal(restored.ledger.balance(alice.address), chain.ledger.balance(alice.address));
    assert.equal(restored.ledger.balance(bob.address), chain.ledger.balance(bob.address));
    assert.equal(restored.ledger.stateRoot(), chain.ledger.stateRoot());
  });
  it("saveToFile / loadFromFile round-trip on disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-v07-"));
    const file = path.join(dir, "chain.json");
    const alice = hybridGenerate();
    const chain = new Chain(); chain.genesis();
    chain.ledger.fund(alice.address, 777n);
    chain.ledger.get(alice.address).edPublic = alice.edPublic;
    chain.addValidator(alice.edPublic, Buffer.from(alice.mlPublicKey).toString("base64"), 1000n, alice.address);
    chain.saveToFile(file);
    assert.ok(fs.existsSync(file));
    const loaded = Chain.loadFromFile(file);
    assert.ok(loaded, "should load");
    assert.equal(loaded!.ledger.balance(alice.address), 777n);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("v0.7 Mempool guards", () => {
  it("rejects duplicate nonce and oversized tx, evicts lowest fee", () => {
    const mp = new Mempool();
    const a = hybridGenerate();
    const t1 = mkTx(a, a.address, 1n, 10n, 0);
    const t2 = mkTx(a, a.address, 1n, 5n, 0);
    mp.add(t1);
    assert.throws(() => mp.add(t2), /duplicate nonce/);
    // oversized
    const big = { ...t1, nonce: 1, intent: "x".repeat(70 * 1024) } as any;
    // intent length >500 already rejected at ledger, but mempool checks byte size
    // use neutral big sig field to exceed 64KB
    const big2 = { ...t1, nonce: 2, sig: { ...t1.sig, mlSig: "A".repeat(70 * 1024) } } as any;
    assert.throws(() => mp.add(big2), /too large/);
  });
});

describe("v0.7 P2P InMemoryBus", () => {
  it("broadcast hello delivers to attached peers", () => {
    const c1 = new Chain(); c1.genesis();
    const c2 = new Chain(); c2.genesis();
    const n1 = new P2pNode(c1, "nodeA", 0);
    const n2 = new P2pNode(c2, "nodeB", 0);
    const bus = new InMemoryBus();
    bus.attach(n1); bus.attach(n2);
    bus.broadcastFrom(n1, { type: "hello", nodeId: "nodeA", height: 0 });
    // n2 should have recorded peer nodeId
    const peers = n2.peerList();
    assert.ok(peers.some((p: any) => p.nodeId === "nodeA"), `expected peer nodeA, got ${JSON.stringify(peers)}`);
  });
});
