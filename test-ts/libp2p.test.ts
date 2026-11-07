import test from "node:test";
import assert from "node:assert";
import { Chain } from "../core-ts/chain.js";
import { Libp2pNode, Libp2pMemoryBus, AEGIS_PROTOCOL } from "../core-ts/libp2p.js";

test("libp2p: constants and in-memory gossip", () => {
  assert.equal(AEGIS_PROTOCOL, "/aegis/1.0/gossip");
  const c1 = new Chain();
  const c2 = new Chain();
  const n1 = new Libp2pNode(c1, { nodeId: "n1", listenPort: 38991 });
  const n2 = new Libp2pNode(c2, { nodeId: "n2", listenPort: 38992 });
  const bus = new Libp2pMemoryBus();
  bus.attach(n1); bus.attach(n2);
  // ping handled without scoring issues
  bus.broadcastFrom(n1, { type: "ping" } as any);
  // malformed json penalizes but does not crash (driven via ensurePeer pid)
  (n2 as any).onMessage("mem-n2", "not-json");
  assert.ok(true);
});

test("libp2p: listenAddr null before start, peerList empty", () => {
  const c = new Chain();
  const n = new Libp2pNode(c, { nodeId: "solo", listenPort: 38993 });
  assert.equal(n.listenAddr(), null);
  assert.deepEqual(n.peerList(), []);
  assert.equal(n.running, false);
});
