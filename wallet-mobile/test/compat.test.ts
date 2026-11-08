import test from "node:test";
import assert from "node:assert";
import {
  hybridGenerate as walletGenerate, hybridSign as walletSign, hybridVerify as walletVerify,
  ledgerTxMessage,
} from "../src/lib/aegis-wallet.js";
import { hybridGenerate, hybridSign, hybridVerify } from "../../core-ts/hybrid.js";
import { Ledger } from "../../core-ts/ledger.js";

// v1.15 regression: the wallet used to hash hex(edSig)+base64(mlSig) into the
// `hybrid` field, so the node rejected EVERY wallet-signed transaction with
// "bad hybrid sig". These tests pin the canonical encoding on both sides.

const seed = new Uint8Array(32).fill(7);

function b64(u8: Uint8Array): string { return Buffer.from(u8).toString("base64"); }

test("wallet keys are byte-identical to core keys for the same seed", () => {
  const w = walletGenerate(seed);
  const c = hybridGenerate(Buffer.from(seed));
  assert.equal(w.address, c.address);
  assert.equal(b64(w.edPublic), c.edPublic);
  assert.equal(b64(w.mlPublicKey), Buffer.from(c.mlPublicKey).toString("base64"));
});

test("wallet signature verifies under core hybridVerify and vice versa", () => {
  const w = walletGenerate(seed);
  const c = hybridGenerate(Buffer.from(seed));
  const msg = "aegis wallet <-> node compatibility";
  const wsig = walletSign(w, msg);
  assert.equal(hybridVerify(c.edPublic, c.mlPublicKey, msg, wsig), true, "core must accept wallet sig");
  const csig = hybridSign(c, msg);
  assert.equal(walletVerify(w.edPublic, w.mlPublicKey, msg, csig), true, "wallet must accept core sig");

  // tampered binding field must be rejected on both sides
  const bad = { ...wsig, hybrid: "0".repeat(64) };
  assert.equal(hybridVerify(c.edPublic, c.mlPublicKey, msg, bad), false);
  assert.equal(walletVerify(w.edPublic, w.mlPublicKey, msg, bad), false);
});

test("wallet-built tx message matches the ledger and the ledger accepts the signature", () => {
  const w = walletGenerate(seed);
  const l = new Ledger();
  l.fund(w.address, 10_000_000n);
  l.get(w.address).edPublic = b64(w.edPublic);

  const fields = {
    from: w.address, to: "aeg1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    amount: "1000", fee: "1000", nonce: 0, intent: "wallet tx", domain: "aegis.local",
    timestamp: 1_700_000_000_000, data: "",
  };
  const walletMsg = ledgerTxMessage({ ...fields, amount: fields.amount, fee: fields.fee });
  const tx: any = { ...fields, amount: 1000n, fee: 1000n, data: "", mlPublicKeyB64: b64(w.mlPublicKey), edPublicB64: b64(w.edPublic) };
  assert.equal(walletMsg, l.txMessage(tx).toString(), "canonical message must match core-ts");

  tx.sig = walletSign(w, walletMsg);
  assert.equal(l.apply(tx), true, "ledger must accept a wallet-signed tx");

  // replay with a broken hybrid binding is rejected
  const replay: any = { ...fields, amount: 1000n, fee: 1000n, nonce: 1, data: "", mlPublicKeyB64: b64(w.mlPublicKey) };
  replay.sig = { ...walletSign(w, l.txMessage(replay)), hybrid: "f".repeat(64) };
  assert.throws(() => l.apply(replay), /hybrid/);
});
