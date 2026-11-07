import test from "node:test";
import assert from "node:assert";
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { Chain } from "../core-ts/chain.js";
import { Ledger } from "../core-ts/ledger.js";
import { createRpcServer } from "../core-ts/rpc.js";
import { hybridGenerate, hybridSign } from "../core-ts/hybrid.js";
import { merkleRoot, merkleProof, verifyMerkleProof } from "../core-ts/merkle.js";
import { FeeMarket, BASE_FEE_FLOOR } from "../core-ts/fee.js";
import {
  PasskeyRegistry, cborEncode, challengeFromHex, verifyRegistration, verifyAssertion,
} from "../core-ts/webauthn.js";

const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");

// ---------- merkle / light client ----------
test("v1.12 merkle: inclusion proof verifies, tamper fails", () => {
  const leaves = ["a", "b", "c", "d", "e"];
  const root = merkleRoot(leaves);
  for (let i = 0; i < leaves.length; i++) {
    const p = merkleProof(leaves, i);
    assert.equal(p.root, root);
    assert.equal(verifyMerkleProof(p), true);
  }
  const bad = merkleProof(leaves, 2);
  bad.leaf = "aeg1attacker";
  assert.equal(verifyMerkleProof(bad), false);
  const badSib = merkleProof(leaves, 1);
  badSib.siblings[0] = "0".repeat(64);
  assert.equal(verifyMerkleProof(badSib), false);
});

test("v1.12 ledger: account proof matches stateRoot and verifies", () => {
  const l = new Ledger();
  const a = hybridGenerate();
  const b = hybridGenerate();
  l.fund(a.address, 1234n);
  l.get(a.address).edPublic = a.edPublic;
  l.fund(b.address, 999n);
  const proof = l.accountProof(a.address);
  assert.equal(proof.root, l.stateRoot());
  assert.equal(verifyMerkleProof(proof), true);
  assert.match(proof.leaf, /^account:/);
  assert.throws(() => l.accountProof("aeg1doesnotexist"), /unknown account/);
});

// ---------- fee market ----------
test("v1.12 fee: empty blocks decay, full blocks raise, floor respected", () => {
  const f = new FeeMarket();
  assert.equal(f.baseFee, 1000n);
  for (let i = 0; i < 40; i++) f.update(0, 500, i + 1);
  assert.ok(f.baseFee < 1000n);
  assert.ok(f.baseFee >= BASE_FEE_FLOOR);
  const low = f.baseFee;
  for (let i = 0; i < 8; i++) f.update(500, 500, 100 + i);
  assert.ok(f.baseFee > low);
  assert.ok(f.history.length <= 64);
  assert.equal(f.accepts(f.baseFee), true);
  assert.equal(f.accepts(f.baseFee - 1n), false);
  assert.ok(f.suggest() > f.baseFee);
});

test("v1.12 chain: blocks move base fee and survive snapshot", () => {
  const chain = new Chain();
  chain.genesis();
  const v = hybridGenerate();
  chain.addValidator(v.edPublic, Buffer.from(v.mlPublicKey).toString("base64"), 1000n, v.address);
  chain.ledger.fund(v.address, 10_000n);
  chain.ledger.get(v.address).edPublic = v.edPublic;
  const before = chain.feeMarket.baseFee;
  chain.produceNextBlock(v, 1);
  assert.ok(chain.feeMarket.baseFee <= before); // empty block → decay
  const restored = Chain.deserialize(chain.serialize());
  assert.equal(restored.feeMarket.baseFee, chain.feeMarket.baseFee);
  assert.equal(restored.height, chain.height);
});

// ---------- TOFU key binding ----------
test("v1.12 ledger: unbound account cannot spend without edPublicB64", () => {
  const l = new Ledger();
  const a = hybridGenerate();
  l.fund(a.address, 100_000n);
  const ts = Date.now();
  const msg = Buffer.from([a.address, a.address, "1000", "1000", 0, "test", "aegis.local", ts, ""].join("|"));
  const sig = hybridSign(a, msg);
  const tx: any = { from: a.address, to: a.address, amount: 1000n, fee: 1000n, nonce: 0, intent: "test", domain: "aegis.local", timestamp: ts, sig, mlPublicKeyB64: Buffer.from(a.mlPublicKey).toString("base64"), data: "" };
  assert.throws(() => l.canApply(tx), /edPublicB64/);
  const other = hybridGenerate();
  assert.throws(() => l.canApply({ ...tx, edPublicB64: other.edPublic }), /derive sender address/);
  l.apply({ ...tx, edPublicB64: a.edPublic });
  assert.equal(l.get(a.address).edPublic, a.edPublic);
  const ts2 = Date.now();
  const msg2 = Buffer.from([a.address, a.address, "1000", "1000", 1, "test", "aegis.local", ts2, ""].join("|"));
  const tx2: any = { ...tx, nonce: 1, timestamp: ts2, sig: hybridSign(a, msg2) };
  assert.doesNotThrow(() => l.canApply(tx2));
});

// ---------- WebAuthn helpers ----------
const ORIGIN = "http://localhost:5173";
const RP_ID = "localhost";

function makePasskey(credIdStr: string, counter = 0) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as any;
  const credId = Buffer.from(credIdStr);
  const rpIdHash = createHash("sha256").update(RP_ID).digest();
  const cose = cborEncode({ "1": 2, "3": -7, "-1": 1, "-2": Buffer.from(jwk.x, "base64url"), "-3": Buffer.from(jwk.y, "base64url") });
  const aaguid = Buffer.alloc(16);

  return {
    credId,
    jwk,
    privateKey: privateKey as KeyObject,
    registration(challenge: string) {
      const flags = Buffer.from([0x01 | 0x04 | 0x40]); // UP + UV + AT
      const counterBuf = Buffer.alloc(4); counterBuf.writeUInt32BE(counter);
      const credLen = Buffer.alloc(2); credLen.writeUInt16BE(credId.length);
      const authData = Buffer.concat([rpIdHash, flags, counterBuf, aaguid, credLen, credId, cose]);
      const attObj = cborEncode({ fmt: "none", attStmt: {}, authData });
      const clientDataJSON = b64url(Buffer.from(JSON.stringify({
        type: "webauthn.create", challenge, origin: ORIGIN, crossOrigin: false,
      })));
      return { credentialId: b64url(credId), clientDataJSON, attestationObject: b64url(attObj) };
    },
    assertion(challenge: string, count = counter + 1) {
      const authData = Buffer.concat([
        rpIdHash,
        Buffer.from([0x01 | 0x04]),
        (() => { const b = Buffer.alloc(4); b.writeUInt32BE(count); return b; })(),
      ]);
      const clientDataJSON = b64url(Buffer.from(JSON.stringify({
        type: "webauthn.get", challenge, origin: ORIGIN, crossOrigin: false,
      })));
      const cdHash = createHash("sha256").update(Buffer.from(clientDataJSON, "base64url")).digest();
      const signature = cryptoSign("sha256", Buffer.concat([authData, cdHash]), privateKey);
      return {
        credentialId: b64url(credId),
        clientDataJSON,
        authenticatorData: b64url(authData),
        signature: b64url(signature),
      };
    },
  };
}

test("v1.12 webauthn: registration + assertion verified, replay/tamper rejected", () => {
  const challenge = challengeFromHex("a".repeat(64));
  const pk = makePasskey("cred-unit-" + Math.random().toString(36).slice(2));
  const reg = pk.registration(challenge);
  const verified = verifyRegistration({
    clientDataJSON: reg.clientDataJSON,
    attestationObject: reg.attestationObject,
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    expectedRpId: RP_ID,
  });
  assert.equal(verified.credentialId, reg.credentialId);
  assert.equal(verified.publicKeyJwk.kty, "EC");

  assert.throws(() => verifyRegistration({
    clientDataJSON: reg.clientDataJSON,
    attestationObject: reg.attestationObject,
    expectedChallenge: challenge,
    expectedOrigin: "https://evil.example",
    expectedRpId: RP_ID,
  }), /origin/);

  const assertionChallenge = challengeFromHex("b".repeat(64));
  const a1 = pk.assertion(assertionChallenge, 5);
  const ok = verifyAssertion({
    clientDataJSON: a1.clientDataJSON,
    authenticatorData: a1.authenticatorData,
    signature: a1.signature,
    expectedChallenge: assertionChallenge,
    expectedOrigin: ORIGIN,
    expectedRpId: RP_ID,
    publicKeyJwk: verified.publicKeyJwk,
    storedCounter: 0,
  });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.newCounter, 5);

  const replay = verifyAssertion({
    clientDataJSON: a1.clientDataJSON,
    authenticatorData: a1.authenticatorData,
    signature: a1.signature,
    expectedChallenge: assertionChallenge,
    expectedOrigin: ORIGIN,
    expectedRpId: RP_ID,
    publicKeyJwk: verified.publicKeyJwk,
    storedCounter: 5,
  });
  assert.equal(replay.ok, false);
  assert.match((replay as any).reason, /counter/);

  const badChallenge = verifyAssertion({
    clientDataJSON: a1.clientDataJSON,
    authenticatorData: a1.authenticatorData,
    signature: a1.signature,
    expectedChallenge: challengeFromHex("c".repeat(64)),
    expectedOrigin: ORIGIN,
    expectedRpId: RP_ID,
    publicKeyJwk: verified.publicKeyJwk,
    storedCounter: 0,
  });
  assert.equal(badChallenge.ok, false);

  const sigBuf = Buffer.from(a1.signature, "base64url");
  sigBuf[10] ^= 0xff;
  const badSig = verifyAssertion({
    clientDataJSON: a1.clientDataJSON,
    authenticatorData: a1.authenticatorData,
    signature: b64url(sigBuf),
    expectedChallenge: assertionChallenge,
    expectedOrigin: ORIGIN,
    expectedRpId: RP_ID,
    publicKeyJwk: verified.publicKeyJwk,
    storedCounter: 0,
  });
  assert.equal(badSig.ok, false);

  // EdDSA (COSE alg -8) path
  const ed = generateKeyPairSync("ed25519");
  const edJwk = ed.publicKey.export({ format: "jwk" }) as any;
  const edChallenge = challengeFromHex("d".repeat(64));
  const edAuth = Buffer.concat([createHash("sha256").update(RP_ID).digest(), Buffer.from([0x01 | 0x04]), Buffer.alloc(4)]);
  const edCd = b64url(Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: edChallenge, origin: ORIGIN, crossOrigin: false })));
  const edCdHash = createHash("sha256").update(Buffer.from(edCd, "base64url")).digest();
  const edSig = cryptoSign(null, Buffer.concat([edAuth, edCdHash]), ed.privateKey);
  const edOk = verifyAssertion({
    clientDataJSON: edCd,
    authenticatorData: b64url(edAuth),
    signature: b64url(edSig),
    expectedChallenge: edChallenge,
    expectedOrigin: ORIGIN,
    expectedRpId: RP_ID,
    publicKeyJwk: edJwk,
    storedCounter: 0,
  });
  assert.equal(edOk.ok, true);
});

// ---------- RPC integration ----------
test("v1.12 rpc: gasPrice, getProof, passkey-gated sendTx", async () => {
  const prevOrigin = process.env.AEGIS_ORIGIN;
  const prevRp = process.env.AEGIS_RP_ID;
  process.env.AEGIS_ORIGIN = ORIGIN;
  process.env.AEGIS_RP_ID = RP_ID;
  try {
    const chain = new Chain();
    chain.genesis();
    const kp = hybridGenerate();
    chain.ledger.fund(kp.address, 1_000_000n);
    chain.ledger.get(kp.address).edPublic = kp.edPublic;
    const passkeys = new PasskeyRegistry();
    const server = createRpcServer(chain, undefined, { passkeys });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as any).port;
    const call = async (method: string, params: any[]) => {
      const r = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return r.json() as any;
    };
    try {
      const gas = await call("aeg_gasPrice", []);
      assert.equal(gas.result.baseFee, "1000");
      assert.ok(BigInt(gas.result.suggestedMaxFee) > 0n);

      const proof = await call("aeg_getProof", [kp.address]);
      assert.equal(proof.result.verified, true);
      assert.equal(proof.result.root, chain.ledger.stateRoot());

      // bind passkey (proof = hybrid sig over deterministic binding message)
      const pk = makePasskey("cred-rpc-" + Math.random().toString(36).slice(2));
      const bindingMsg = Buffer.from(`aegis-passkey-bind|${kp.address}|${b64url(pk.credId)}`);
      const challenge = createHash("sha256").update(bindingMsg).digest("hex");
      const reg = pk.registration(challengeFromHex(challenge));
      const bound = await call("aeg_passkeyRegister", [
        kp.address, b64url(pk.credId), reg.clientDataJSON, reg.attestationObject,
        hybridSign(kp, bindingMsg), Buffer.from(kp.mlPublicKey).toString("base64"),
      ]);
      assert.equal(bound.result?.bound, true, JSON.stringify(bound));

      const mkTx = (nonce: number) => {
        const ts = Date.now();
        const msg = Buffer.from([kp.address, kp.address, "1000", "1000", nonce, "test", "aegis.local", ts, ""].join("|"));
        return {
          from: kp.address, to: kp.address, amount: "1000", fee: "1000", nonce,
          intent: "test", domain: "aegis.local", timestamp: ts,
          sig: hybridSign(kp, msg), mlPublicKeyB64: Buffer.from(kp.mlPublicKey).toString("base64"), data: "",
        };
      };

      const tx1 = mkTx(0);
      const noAssertion = await call("aeg_sendTx", [tx1]);
      assert.match(JSON.stringify(noAssertion), /passkey assertion required/);

      const txMsg = Buffer.from([tx1.from, tx1.to, tx1.amount, tx1.fee, tx1.nonce, tx1.intent, tx1.domain, tx1.timestamp, tx1.data].join("|"));
      const txChallenge = createHash("sha256").update(txMsg).digest("hex");
      const assertion = pk.assertion(challengeFromHex(txChallenge));
      const accepted = await call("aeg_sendTx", [tx1, assertion]);
      assert.equal(accepted.result?.accepted, true, JSON.stringify(accepted));

      // replaying the same assertion on a different tx must fail (challenge is tx-bound)
      const other = hybridGenerate();
      const ts2 = Date.now() + 1;
      const msg2 = Buffer.from([kp.address, other.address, "1000", "1000", 0, "test", "aegis.local", ts2, ""].join("|"));
      const tx2 = {
        from: kp.address, to: other.address, amount: "1000", fee: "1000", nonce: 0,
        intent: "test", domain: "aegis.local", timestamp: ts2,
        sig: hybridSign(kp, msg2), mlPublicKeyB64: Buffer.from(kp.mlPublicKey).toString("base64"), data: "",
      };
      const replayed = await call("aeg_sendTx", [tx2, assertion]);
      assert.match(JSON.stringify(replayed), /passkey assertion rejected/);

      const info = await call("aeg_passkeyInfo", [kp.address]);
      assert.equal(info.result.length, 1);
      assert.equal(info.result[0].counter, 1);
    } finally {
      server.close();
    }
  } finally {
    process.env.AEGIS_ORIGIN = prevOrigin;
    process.env.AEGIS_RP_ID = prevRp;
  }
});
