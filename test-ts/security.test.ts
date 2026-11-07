import test from "node:test";
import assert from "node:assert";
import { hybridGenerate, hybridSign, hybridVerify, mlKeySizes } from "../core-ts/hybrid.js";
import { signIntent, verifyIntent, behavioralScore } from "../core-ts/aegis.js";
import { Ledger } from "../core-ts/ledger.js";
import { Chain } from "../core-ts/chain.js";
import { createHash, randomBytes } from "node:crypto";

test("security: hybrid size guards reject truncated sigs without throwing", () => {
  const kp = hybridGenerate(randomBytes(32));
  const sig = hybridSign(kp, "hello");
  assert.equal(hybridVerify(kp.edPublic, kp.mlPublicKey, "hello", sig), true);
  // truncated ML sig
  const bad = { ...sig, mlSig: sig.mlSig.slice(0, 100) };
  assert.equal(hybridVerify(kp.edPublic, kp.mlPublicKey, "hello", bad), false);
  // wrong hybrid binding
  const bad2 = { ...sig, hybrid: "0".repeat(64) };
  assert.equal(hybridVerify(kp.edPublic, kp.mlPublicKey, "hello", bad2), false);
  // wrong public key length
  assert.equal(hybridVerify(kp.edPublic, kp.mlPublicKey.slice(0, 100), "hello", sig), false);
  assert.deepEqual(mlKeySizes(), { publicKeyBytes: 1952, secretKeyBytes: 4032, sigBytes: 3309 });
});

test("security: domain binding — sig for market A fails on market B", () => {
  const kp = hybridGenerate(randomBytes(32));
  const ent = randomBytes(16);
  const signed = signIntent(kp, { from: kp.address, to: "aeg1bob", amount: 100n, intent: "sale", domain: "market.aegis.local", expiry: Math.floor(Date.now()/1000)+300 }, ent, "genesis");
  const ok = verifyIntent(kp.edPublic, kp.mlPublicKey, signed);
  assert.equal(ok.ok, true);
  const tampered = { ...signed, domain: "evil.com" };
  const bad = verifyIntent(kp.edPublic, kp.mlPublicKey, tampered);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /sig mismatch/);
  // tamper recipient
  const tampered2 = { ...signed, to: "aeg1attacker" };
  assert.equal(verifyIntent(kp.edPublic, kp.mlPublicKey, tampered2).ok, false);
});

test("security: liveness response tamper fails verifyIntent", () => {
  const kp = hybridGenerate(randomBytes(32));
  const ent = randomBytes(16);
  const signed = signIntent(kp, { from: kp.address, to: "aeg1bob", amount: 100n, intent: "sale", domain: "market.aegis.local", expiry: Math.floor(Date.now()/1000)+300 }, ent, "genesis");
  const bad = { ...signed, livenessResponse: { ...signed.livenessResponse, hybrid: "0".repeat(64) } };
  const v = verifyIntent(kp.edPublic, kp.mlPublicKey, bad);
  assert.equal(v.ok, false);
});

test("security: ledger rejects replayed nonce via canApply", () => {
  const l = new Ledger();
  const alice = hybridGenerate(randomBytes(32));
  l.fund(alice.address, 1_000_000_000_000n);
  l.get(alice.address).edPublic = alice.edPublic;
  const mk = (nonce: number) => {
    const base: any = {
      from: alice.address, to: "aeg1bob", amount: 500_000n, fee: 1000n, nonce,
      intent: "test", domain: "market.aegis.local", timestamp: Date.now(),
      sig: { edSig: "", mlSig: "", hybrid: "" }, mlPublicKeyB64: Buffer.from(alice.mlPublicKey).toString("base64"), data: "",
    };
    base.sig = hybridSign(alice, l.txMessage(base));
    return base;
  };
  // good tx applies, same nonce replay fails
  l.canApply(mk(0));
  l.apply(mk(0));
  assert.throws(() => l.canApply(mk(0)), /nonce/);
});

test("security: behavioralScore blocks bot (regular intervals, fast confirm)", () => {
  const regular = Array(20).fill(500);
  const r = behavioralScore(regular, "abcd1234", 200);
  assert.equal(r.verdict, "blocked");
  const human = behavioralScore([120, 900, 200, 1500, 400, 800], "abcd1234", 4000);
  assert.equal(human.verdict, "allow");
});
