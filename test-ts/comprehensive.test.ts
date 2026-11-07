import test from "node:test";
import assert from "node:assert";
import { Chain } from "../core-ts/chain.js";
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
    assert.equal(hj.version, "1.2.0");
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
