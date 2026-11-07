// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../AegisPaymaster.sol";

contract PaymasterTest {
    AegisPaymaster pm;
    address user = address(0xBEEF);

    function setUp() public {
        pm = new AegisPaymaster();
        (bool ok, ) = address(pm).call{value: 1 ether}("");
        assert(ok);
    }

    function test_sponsor_within_cap() public {
        pm.sponsor(user, 1_000_000);
        assert(pm.spentToday(user) == 1_000_000);
    }

    function test_sponsor_over_cap_reverts() public {
        pm.sponsor(user, 1_000_000);
        bool bad;
        try pm.sponsor(user, 1) {} catch { bad = true; }
        assert(bad);
    }

    function assert(bool cond) internal pure {
        if (!cond) revert("assert failed");
    }
}
