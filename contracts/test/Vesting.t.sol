// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../AegisVesting.sol";

contract MockVestingToken {
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function faucet() external { balanceOf[msg.sender] += 10_000_000_000000; }
    function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; return true; }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
    function transferFrom(address f, address t, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        require(a >= v, "allowance");
        if (a != type(uint256).max) allowance[f][msg.sender] = a - v;
        balanceOf[f] -= v; balanceOf[t] += v; return true;
    }
}

contract VestingTest {
    MockVestingToken token;
    AegisVesting vesting;

    function setUp() public {
        token = new MockVestingToken();
        token.faucet();
        vesting = new AegisVesting(address(token));
    }

    function test_create_and_claimable_cliff() public {
        address who = address(0xBEEF);
        token.approve(address(vesting), 1_000_000_000000);
        vesting.create(who, 1_000_000_000000);
        // before cliff (180 days) — nothing claimable
        assert(vesting.claimable(who) == 0);
    }

    function test_duplicate_create_reverts() public {
        address who = address(0xBEEF);
        token.approve(address(vesting), 1_000_000_000000);
        vesting.create(who, 1_000_000_000000);
        bool bad;
        token.approve(address(vesting), 1_000_000_000000);
        try vesting.create(who, 1_000_000_000000) {} catch { bad = true; }
        assert(bad);
    }

    function assert(bool cond) internal pure {
        if (!cond) revert("assert failed");
    }
}
