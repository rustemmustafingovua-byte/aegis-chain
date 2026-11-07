import test from "node:test";
import assert from "node:assert";
import { Chain } from "../core-ts/chain.js";
import { createRpcServer } from "../core-ts/rpc.js";
import { loadConfig } from "../core-ts/config.js";

test("prod: config validates env", () => {
  const c = loadConfig({ port: 8899 });
  assert.equal(c.port, 8899);
  assert.equal(c.libp2pPort, 4899);
  assert.equal(c.rpcRateLimit >= 1, true);
});

test("prod: admin token gates faucet when set", async () => {
  const prev = process.env.AEGIS_ADMIN_TOKEN;
  process.env.AEGIS_ADMIN_TOKEN = "secret-token-1234";
  const chain = new Chain();
  const server = createRpcServer(chain);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/rpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "aeg_faucet", params: ["aeg1testFaucetAddr0000000000000000000000000000000", "100"] }) });
    const j = await r.json();
    assert.match(JSON.stringify(j), /admin token required/);
    const ok = await fetch(`http://127.0.0.1:${port}/rpc`, { method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Token": "secret-token-1234" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "aeg_faucet", params: ["aeg1testFaucetAddr0000000000000000000000000000000", "100"] }) });
    const oj = await ok.json();
    assert.ok(oj.result.funded);
  } finally { server.close(); process.env.AEGIS_ADMIN_TOKEN = prev; }
});

test("prod: getBlocks pagination window", async () => {
  const chain = new Chain();
  chain.genesis();
  const server = createRpcServer(chain);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/rpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "aeg_getBlocks", params: [0, 1] }) });
    const j = await r.json();
    assert.equal(j.result.length, 1);
    assert.equal(j.result[0].height, 0);
  } finally { server.close(); }
});
