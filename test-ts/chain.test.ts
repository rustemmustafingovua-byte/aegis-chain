import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hybridGenerate, hybridSign } from "../core-ts/hybrid.js";
import { Chain } from "../core-ts/chain.js";
import { Ledger } from "../core-ts/ledger.js";

describe("Chain", () => {
  it("genesis + fund + hybrid tx in block", () => {
    const alice = hybridGenerate();
    const bob = hybridGenerate();
    const chain = new Chain();
    chain.genesis();
    chain.ledger.fund(alice.address, 1000n);
    chain.ledger.fund(bob.address, 100n);
    chain.ledger.get(alice.address).edPublic = alice.edPublic;
    chain.addValidator(alice.edPublic, Buffer.from(alice.mlPublicKey).toString("base64"), 1000n);
    const ts = Date.now();
    const msg = Buffer.from([alice.address, bob.address, "1", "0", chain.ledger.get(alice.address).nonce, "test", "aegis.example", ts].join("|"));
    const sig = hybridSign(alice, msg);
    const tx = { from: alice.address, to: bob.address, amount: 1n, fee: 0n, nonce: 0, intent: "test", domain: "aegis.example", timestamp: ts, sig, mlPublicKeyB64: Buffer.from(alice.mlPublicKey).toString("base64") };
    const block = chain.propose([tx as any], alice, 1);
    assert.equal(chain.accept(block), true);
    assert.equal(chain.ledger.balance(alice.address), 999n);
    assert.equal(chain.ledger.balance(bob.address), 101n);
    assert.equal(chain.height, 1);
  });
});
