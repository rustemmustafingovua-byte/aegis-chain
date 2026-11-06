import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Chain } from "../core-ts/chain.js";
import { createRpcServer } from "../core-ts/rpc.js";
import { hybridGenerate } from "../core-ts/hybrid.js";

describe("RPC", () => {
  let server: any;
  let port: number;
  before(async () => {
    const chain = new Chain();
    chain.genesis();
    server = createRpcServer(chain);
    await new Promise<void>((r) => server.listen(0, () => r()));
    port = server.address().port;
  });
  after(() => server.close());
  it("aeg_getState", async () => {
    const r = await fetch(`http://localhost:${port}/api/rpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "aeg_getState", params: [] }) });
    const j: any = await r.json();
    assert.equal(j.result.height, 0);
  });
  it("aeg_getBalance", async () => {
    const alice = hybridGenerate();
    const r = await fetch(`http://localhost:${port}/api/rpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "aeg_getBalance", params: [alice.address] }) });
    const j: any = await r.json();
    assert.equal(j.result, "0");
  });
  it("/health", async () => {
    const r = await fetch(`http://localhost:${port}/health`);
    const j: any = await r.json();
    assert.equal(j.ok, true);
  });
});
