import test from "node:test";
import assert from "node:assert";
import { Chain } from "../../core-ts/chain.js";
import { hybridGenerate } from "../../core-ts/hybrid.js";
import { createCheckpoint } from "../../core-ts/checkpoints.js";
import { headerFromBlock, validatorViewOf } from "../../core-ts/headers.js";
import { lightBalance, verifyCheckpoint, verifyHeaders, parseAccountLeaf, type Checkpoint } from "../src/lib/light.js";

// v1.15: wallet verifies balance itself — checkpoint signatures (incl. ML-DSA-65),
// header chain, Merkle account proof. The node is treated as untrusted input.

const seed = Buffer.from("aegis-wallet-light-test-seed-0001", "utf8").subarray(0, 32);

function setup(stake = 10_000n) {
  const kp = hybridGenerate(seed);
  const chain = new Chain();
  chain.genesis();
  chain.ledger.fund(kp.address, 5_000_000n);
  chain.ledger.get(kp.address).edPublic = kp.edPublic;
  chain.ledger.get(kp.address).humanityScore = 90;
  chain.addValidator(kp.edPublic, Buffer.from(kp.mlPublicKey).toString("base64"), stake, kp.address);
  for (let slot = 1; slot <= 3; slot++) chain.produceNextBlock(kp, slot);
  return { kp, chain };
}

function validatorList(chain: Chain) {
  return [...validatorViewOf(chain)].map(([edPublic, v]) => ({
    edPublic, publicKey: v.publicKey, mlPublicKeyB64: v.mlPublicKeyB64,
    stake: v.stake.toString(), address: v.address ?? null,
  }));
}

function fakeCall(chain: Chain, cp: Checkpoint | null, opts: { tamperProof?: boolean; tamperHeader?: boolean } = {}) {
  return async (method: string, params: any[]): Promise<any> => {
    switch (method) {
      case "aeg_validatorSet": return validatorList(chain);
      case "aeg_checkpointLatest": return cp ? { checkpoint: cp, verification: {} } : null;
      case "aeg_getState": return { height: chain.height, nullifierRoot: chain.ledger.nullifierRoot() };
      case "aeg_getHeaders": {
        const [from, to] = params as [number, number];
        const headers = chain.blocks.filter((b) => b.header.height >= from && b.header.height <= to).map(headerFromBlock);
        if (opts.tamperHeader && headers.length > 1) headers[1] = { ...headers[1], hash: "f".repeat(64) };
        return headers;
      }
      case "aeg_getProof": {
        const proof = chain.ledger.accountProof(params[0]);
        if (opts.tamperProof) return { ...proof, leaf: proof.leaf.replace(/:(\d+):(\d+):/, ":999999:0:") };
        return proof;
      }
      default: throw new Error(`unexpected method ${method}`);
    }
  };
}

test("v1.15 wallet light client: verifies checkpoint, headers and account proof", async () => {
  const { kp, chain } = setup();
  const cp = createCheckpoint(chain, kp); // checkpoint at tip (height 3)
  const res = await lightBalance(fakeCall(chain, cp), kp.address);

  assert.equal(res.verified, true, res.alerts.join(" · ") + " " + (res.reason ?? ""));
  assert.equal(res.balance, "5000000");
  assert.equal(res.checkpointHeight, 3);
  assert.equal(res.height, 3);
  assert.ok(res.checks.every((c) => c.ok), JSON.stringify(res.checks));
  assert.equal(res.alerts.length, 0);
});

test("v1.15 wallet light client: PQ checkpoint signature is checked locally", async () => {
  const { kp, chain } = setup();
  const cp = createCheckpoint(chain, kp);
  const validators = new Map([...validatorViewOf(chain)]);
  assert.equal(verifyCheckpoint(cp, validators).ok, true);

  // forge a signature with another key: node's word alone must not be enough
  const forged = { ...cp, stateRoot: "0".repeat(64), signatures: cp.signatures.map((s) => ({ ...s, sig: { ...s.sig, hybrid: "0".repeat(64) } })) };
  assert.equal(verifyCheckpoint(forged, validators).ok, false);

  // the wallet refuses the balance when the checkpoint is not final
  const res = await lightBalance(fakeCall(chain, forged), kp.address);
  assert.equal(res.verified, false);
  assert.match(res.alerts.join(" "), /checkpoint not final|insufficient stake/);
});

test("v1.15 wallet light client: tampered proof leaf / header is rejected", async () => {
  const { kp, chain } = setup();
  const cp = createCheckpoint(chain, kp);

  const badProof = await lightBalance(fakeCall(chain, cp, { tamperProof: true }), kp.address);
  assert.equal(badProof.verified, false);

  // header chain from an older checkpoint must be verified; tampering breaks it
  const early = createCheckpoint({ height: 1, ledger: chain.ledger, head: chain.blocks[1] }, kp);
  const badHeader = await lightBalance(fakeCall(chain, early, { tamperHeader: true }), kp.address);
  assert.equal(badHeader.verified, false);
  assert.match(badHeader.alerts.join(" "), /header|hash|prevHash/);
});

test("v1.15 wallet light client: stale checkpoint does not claim a verified balance", async () => {
  const { kp, chain } = setup();
  const cp = createCheckpoint(chain, kp); // snapshot at height 3
  // state changes after the checkpoint: another account funded + new blocks
  chain.ledger.fund("aeg1qtarant", 123n);
  chain.produceNextBlock(kp, 4);
  chain.produceNextBlock(kp, 5);

  const res = await lightBalance(fakeCall(chain, cp), kp.address);
  assert.equal(res.verified, false, "tip state root is not signed by the checkpoint yet");
  assert.ok(res.alerts.some((a) => /состояние изменилось|state/.test(a)) || res.checks.some((c) => c.label === "state root = checkpoint" && !c.ok));
  // headers still verify: continuity is proven even when the state is stale
  const headerCheck = res.checks.find((c) => c.label === "header chain");
  assert.equal(headerCheck?.ok, true, JSON.stringify(res.checks));
});

test("v1.15 light client: account leaf parsing", () => {
  const leaf = "account:aeg1abc:1234:56:7:8";
  assert.deepEqual(parseAccountLeaf(leaf), { address: "aeg1abc", balance: 1234n, stake: 56n, nonce: 7, pendingUnstake: 8n });
  assert.equal(parseAccountLeaf("pool:AEGIS/USDC:1:2:3"), null);
});
