import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../core-ts/ledger.js";
import { Governance } from "../core-ts/governance.js";
import { Chain } from "../core-ts/chain.js";
import { Bridge } from "../core-ts/bridge.js";
import { Discovery } from "../core-ts/discovery.js";
import { hybridGenerate, hybridSign } from "../core-ts/hybrid.js";

describe("AMM x*y=k 0.3% + LP", () => {
  it("addLiquidity + swap + removeLiquidity", () => {
    const l = new Ledger();
    const alice = hybridGenerate();
    const shares = l.addLiquidity("AEGIS/USDC", 1_000_000n, 1_000_000n, alice.address);
    assert.ok(shares > 0n);
    const out = l.quoteSwap("AEGIS/USDC", 100_000n);
    assert.ok(out > 0n && out < 100_000n, "fee should reduce output");
    const swapped = l.swap("AEGIS/USDC", 100_000n);
    assert.equal(swapped, out);
    const [b, q] = l.removeLiquidity("AEGIS/USDC", alice.address);
    assert.ok(b > 0n && q > 0n);
  });
  it("staking + slash", () => {
    const l = new Ledger();
    const a = hybridGenerate();
    l.fund(a.address, 20_000_000000n);
    l.get(a.address).edPublic = a.edPublic;
    // stake via data
    const ts = Date.now();
    const msg = Buffer.from([a.address, a.address, "10000000000", "0", 0, "stake", "aegis.local", ts, "stake:AEGIS/USDC"].join("|"));
    const sig = hybridSign(a, msg);
    l.apply({ from: a.address, to: a.address, amount: 10_000_000000n, fee: 0n, nonce: 0, intent: "stake", domain: "aegis.local", timestamp: ts, sig, mlPublicKeyB64: Buffer.from(a.mlPublicKey).toString("base64"), data: "stake:AEGIS/USDC" } as any);
    assert.ok(l.get(a.address).stake >= 10_000_000000n);
    const slashed = l.slash(a.address, 1000n);
    assert.ok(slashed > 0n);
  });
});

describe("Governance anti-Sybil", () => {
  it("vote once, tally 2/3 + humanity", () => {
    const chain = new Chain(); chain.genesis();
    const alice = hybridGenerate(); const bob = hybridGenerate();
    chain.addValidator(alice.edPublic, "x", 100n);
    chain.ledger.get(alice.address).stake = 150n;
    chain.ledger.get(bob.address).stake = 100n;
    chain.ledger.get(alice.address).humanityScore = 90;
    chain.ledger.get(bob.address).humanityScore = 85;
    const gov = new Governance(chain);
    gov.create("p1", "upgrade", "v0.6", alice.address);
    gov.vote("p1", alice.address, true);
    gov.vote("p1", bob.address, true);
    assert.throws(() => gov.vote("p1", alice.address, true), /already voted/);
    const p = gov.tally("p1");
    assert.equal(p?.status, "passed");
  });
});

describe("Bridge HTLC + Discovery", () => {
  it("HTLC fund/claim/refund", () => {
    const b = new Bridge();
    const h = b.fund("id1", "alice", "bob", 100n);
    b.claim("id1", h.secret!);
    assert.equal(b.htlcs.get("id1")?.state, "claimed");
  });
  it("Discovery closest", () => {
    const d = new Discovery();
    d.add({ id: "aaa", host: "h", port: 1, lastSeen: 0, score: 10 });
    d.add({ id: "bbb", host: "h", port: 2, lastSeen: 0, score: 5 });
    assert.equal(d.list().length, 2);
    assert.equal(d.closest("aaa")[0].id, "aaa");
  });
});
