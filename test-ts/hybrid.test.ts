import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { hybridGenerate, hybridSign, hybridVerify, mlKeySizes } from "../core-ts/hybrid.js";
import { signIntent, verifyIntent } from "../core-ts/aegis.js";
import { shamirSplit, shamirRecover } from "../core-ts/shamir.js";
import { MeshNode, makePacket } from "../core-ts/mesh.js";

describe("ML-DSA-65 hybrid", () => {
  it("sizes match FIPS-204", () => {
    const s = mlKeySizes();
    assert.equal(s.publicKeyBytes, 1952);
    assert.equal(s.sigBytes, 3309);
  });
  it("sign+verify hybrid", () => {
    const k = hybridGenerate();
    const sig = hybridSign(k, Buffer.from("hello AEGIS"));
    assert.equal(hybridVerify(k.edPublic, k.mlPublicKey, Buffer.from("hello AEGIS"), sig), true);
    assert.equal(hybridVerify(k.edPublic, k.mlPublicKey, Buffer.from("tampered"), sig), false);
  });
  it("deterministic from seed", () => {
    const seed = randomBytes(32);
    const a = hybridGenerate(seed);
    const b = hybridGenerate(seed);
    assert.equal(a.address, b.address);
    assert.deepEqual(a.mlPublicKey, b.mlPublicKey);
  });
  it("intent binding blocks tamper", () => {
    const alice = hybridGenerate();
    const bob = hybridGenerate();
    const tx = signIntent(alice, { from: alice.address, to: bob.address, amount: 10n, intent: "sale #1", domain: "a.example", expiry: Math.floor(Date.now()/1000)+120 }, randomBytes(16), "genesis");
    assert.equal(verifyIntent(alice.edPublic, alice.mlPublicKey, tx).ok, true);
    const tampered = { ...tx, to: "aeg1ATTACKER" };
    assert.equal(verifyIntent(alice.edPublic, alice.mlPublicKey, tampered).ok, false);
  });
});

describe("Shamir 3/5", () => {
  it("recovers", () => {
    const secret = randomBytes(32);
    const shares = shamirSplit(secret, 5, 3);
    const rec = shamirRecover([shares[0], shares[2], shares[4]]);
    assert.deepEqual(rec, secret);
  });
  it("2 shares fail", () => {
    const secret = randomBytes(8);
    const shares = shamirSplit(secret, 5, 3);
    assert.throws(() => shamirRecover([shares[0], shares[1]]));
  });
});

describe("Mesh offline", () => {
  it("offline gossip + double-spend detect", () => {
    const a = hybridGenerate();
    const b = hybridGenerate();
    const nA = new MeshNode("A", a);
    const nB = new MeshNode("B", b);
    nA.connect(nB);
    const tx = nA.signOffline(b.address, 5n, "offline", "mesh.local", randomBytes(16));
    const pkt = makePacket(tx);
    const nodes = { A: nA, B: nB };
    nA.gossip(nodes);
    assert.equal(nB.mempool.size, 1);
    // duplicate nullifier
    const pkt2 = makePacket(tx);
    const status = nB.receive(pkt2);
    assert.ok(status.includes("dedup") || status.includes("conflict"));
  });
});
