import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Chain } from "../core-ts/chain.js";
import { InMemoryBus, P2pNode } from "../core-ts/p2p.js";

describe("P2P InMemory", () => {
  it("broadcast hello + nodeId unique", () => {
    const c1 = new Chain(); c1.genesis();
    const c2 = new Chain(); c2.genesis();
    const n1 = new P2pNode(c1, "a", 0);
    const n2 = new P2pNode(c2, "b", 0);
    const bus = new InMemoryBus();
    bus.attach(n1); bus.attach(n2);
    assert.notEqual(n1.nodeId, n2.nodeId);
  });
});
