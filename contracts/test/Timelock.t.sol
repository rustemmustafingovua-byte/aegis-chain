// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../AegisTimelock.sol";

contract TimelockTest {
    AegisTimelock tl;
    address target = address(0xBEEF);

    function setUp() public {
        tl = new AegisTimelock();
        (bool ok, ) = address(tl).call{value: 1 ether}("");
        assert(ok);
    }

    function test_queue_early_execute_reverts() public {
        uint256 id = tl.queue(target, 0.1 ether, "");
        assert(tl.opCount() == 1);
        bool bad;
        try tl.execute(id) {} catch { bad = true; }
        assert(bad); // eta = +24h, not yet
    }

    function test_cancel() public {
        uint256 id = tl.queue(target, 0.1 ether, "");
        tl.cancel(id);
        (address to, , , , , ) = tl.ops(id);
        assert(to == target);
    }

    function assert(bool cond) internal pure {
        if (!cond) revert("assert failed");
    }
}
