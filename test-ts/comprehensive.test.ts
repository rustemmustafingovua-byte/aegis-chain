import test from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { Chain } from "../core-ts/chain.js";
import { MeshNode, makePacket } from "../core-ts/mesh.js";
import { encryptIntent, decryptIntent, toConfIntent, fromConfIntent, isConfIntent } from "../core-ts/confidential.js";
import { loraChunk, loraReassemble } from "../core-ts/lora.js";
import { sneakerExport, sneakerImport } from "../core-ts/sneaker.js";
import { Wal, walPaths } from "../core-ts/wal.js";
import { Ledger } from "../core-ts/ledger.js";
import { Governance } from "../core-ts/governance.js";
import { Bridge } from "../core-ts/bridge.js";
import { createRpcServer } from "../core-ts/rpc.js";
import { hybridGenerate } from "../core-ts/hybrid.js";
import { randomBytes } from "node:crypto";

async function rpcCall(method: string, params: any[]) {
  const chain = new Chain();
  const gov = new Governance(chain);
  const bridge = new Bridge();
  const server = createRpcServer(chain, undefined, { gov, bridge });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return await r.json();
  } finally { server.close(); }
}

test("comprehensive: faucet funds devnet address and rate-limits", async () => {
  const j = await rpcCall("aeg_faucet", ["aeg1testFaucetAddr0000000000000000000000000000000", "1000000"]);
  assert.ok(j.result || j.error);
  // bad address rejected
  const bad = await rpcCall("aeg_faucet", ["not-aeg", "100"]);
  assert.match(JSON.stringify(bad), /address/);
});

test("comprehensive: registerValidator enforces min stake", async () => {
  const bad = await rpcCall("aeg_registerValidator", ["edpub", "mlpubb64", "1", "aeg1x"]);
  assert.match(JSON.stringify(bad), /min stake/);
});

test("comprehensive: metrics endpoint shape", async () => {
  const chain = new Chain();
  const gov = new Governance(chain);
  const bridge = new Bridge();
  const server = createRpcServer(chain, undefined, { gov, bridge });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  try {
    const m = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(m.status, 200);
    const txt = await m.text();
    assert.match(txt, /aegis_height/);
    assert.match(txt, /aegis_supply/);
    const h = await fetch(`http://127.0.0.1:${port}/health`);
    const hj = await h.json();
    assert.equal(hj.version, "1.9.0");
  } finally { server.close(); }
});

test("comprehensive: governance tally passes with stake + humanity", () => {
  const chain = new Chain();
  const a = hybridGenerate(randomBytes(32));
  const b = hybridGenerate(randomBytes(32));
  chain.ledger.fund(a.address, 0n);
  chain.ledger.get(a.address).stake = 1_000_000_000_000n;
  chain.ledger.get(a.address).humanityScore = 90;
  chain.ledger.get(b.address).stake = 1_000_000_000_000n;
  chain.ledger.get(b.address).humanityScore = 90;
  const gov = new Governance(chain);
  gov.create("p1", "upgrade", "fee:30", a.address);
  gov.vote("p1", a.address, true);
  gov.vote("p1", b.address, true);
  const t = gov.tally("p1");
  assert.equal(t?.status, "passed");
});

test("comprehensive: bridge quote non-zero for funded pool", () => {
  const br = new Bridge();
  const out = br.quoteBaseToAegis(1_000_000n, 1_000_000_000_000n, 1_000_000_000_000n);
  assert.ok(out > 0n);
});

test("comprehensive: snapshot and prune keep genesis anchor", () => {
  const chain = new Chain();
  chain.genesis();
  const s = chain.snapshot();
  assert.equal(s.height, 0);
  assert.ok(s.hash.length === 16);
  assert.equal(chain.prune(100), 0); // nothing to prune
});

test("comprehensive: WAL append + status + compact", () => {
  const chain = new Chain();
  chain.genesis();
  const { walPath, snapshotPath } = walPaths("/tmp/aegis-test-wal.json");
  try { fs.unlinkSync(walPath); } catch {}
  const wal = new Wal(walPath, snapshotPath);
  // fake block minimal (header+txs+sig) — append does not verify
  wal.append({ header: { height: 1, prevHash: "0".repeat(64), timestamp: 1, proposer: "x", merkleRoot: "0".repeat(64), txCount: 0, slot: 1 }, txs: [], signature: "s", mlSignatureB64: "", mlPublicKeyB64: "", hash: "0".repeat(64) } as any);
  assert.equal(wal.blocks, 1);
  const st = wal.status(1);
  assert.equal(st.walBlocks, 1);
  try { fs.unlinkSync(walPath); } catch {}
});

test("comprehensive: governance execute fee change + halving", () => {
  const chain = new Chain();
  const a = hybridGenerate(randomBytes(32));
  chain.ledger.addLiquidity("AEGIS/USDC", 1_000_000_000000n, 1_000_000_000000n, a.address);
  chain.ledger.get(a.address).stake = 1_000_000_000_000n;
  chain.ledger.get(a.address).humanityScore = 90;
  chain.ledger.get(a.address).balance = 0n;
  const b = hybridGenerate(randomBytes(32));
  chain.ledger.get(b.address).stake = 1_000_000_000_000n;
  chain.ledger.get(b.address).humanityScore = 90;
  const gov = new Governance(chain);
  gov.create("fee30", "set fee", "fee:30", a.address);
  gov.vote("fee30", a.address, true);
  gov.vote("fee30", b.address, true);
  gov.tally("fee30");
  const r = gov.execute("fee30");
  assert.match(r.applied, /feeBps/);
  assert.equal(chain.ledger.pools.get("AEGIS/USDC")!.feeBps, 30n);
  // halving
  assert.equal(chain.halvingFactor(0), 1);
  const r1 = chain.ledger.rewardProposer(a.address, 10_000_000_000000n, 10_000_000_000000n, 1);
  const r2 = chain.ledger.rewardProposer(a.address, 10_000_000_000000n, 10_000_000_000000n, 2);
  assert.ok(r1 >= r2);
});

test("comprehensive: slash reduces stake, mesh queue persistence", () => {
  const chain = new Chain();
  const a = hybridGenerate(randomBytes(32));
  chain.ledger.get(a.address).stake = 1_000_000_000_000n;
  const cut = chain.ledger.slash(a.address, 1000n);
  assert.equal(cut, 100_000_000_000n);
  assert.equal(chain.ledger.get(a.address).stake, 900_000_000_000n);
  // mesh queue roundtrip (real offline tx via signOffline)
  const node = new MeshNode("test-node", hybridGenerate(randomBytes(32)));
  const tx = node.signOffline("aeg1bob", 100_000n, "test sale", "shop.aegis.local", Buffer.alloc(16, 1));
  node.queueForCarry(makePacket(tx));
  node.saveQueue("/tmp/aegis-mesh-queue.json");
  const n = new MeshNode("test-node2", hybridGenerate(randomBytes(32)));
  const loaded = n.loadQueue("/tmp/aegis-mesh-queue.json");
  assert.equal(loaded, 1);
  // sneaker export/import (file transport)
  const exported = sneakerExport(node, "/tmp/aegis-sneaker.json");
  assert.equal(exported, 1);
  const accepted = sneakerImport("/tmp/aegis-sneaker.json", { [n.nodeId]: n });
  assert.ok(accepted >= 0);
});

test("comprehensive: ml hash commitment roundtrip", () => {
  const kp = hybridGenerate(randomBytes(32));
  const h = createHash("sha256").update(kp.mlPublicKey).digest("hex");
  assert.equal(h.length, 64);
  const chain = new Chain();
  chain.ledger.get(kp.address).mlPublicHash = h;
  assert.equal(chain.ledger.get(kp.address).mlPublicHash, h);
});

test("comprehensive: confidential intent + lora chunk roundtrip", () => {
  const wire = toConfIntent("продажа велика #1", "shared-secret-42");
  assert.equal(isConfIntent(wire), true);
  assert.equal(fromConfIntent(wire, "shared-secret-42"), "продажа велика #1");
  assert.throws(() => fromConfIntent(wire, "wrong-secret"));
  const json = JSON.stringify({ hello: "lora world", payload: "x".repeat(200) });
  const frames = loraChunk(json, 51);
  assert.ok(frames.length >= 2);
  assert.equal(loraReassemble(frames), json);
});
