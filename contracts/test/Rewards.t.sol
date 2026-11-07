// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../AegisRewards.sol";

contract MockRewardsToken {
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    function faucetTok() external { balanceOf[msg.sender] += 10_000_000_000000; }
    function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; return true; }
}

contract RewardsTest {
    MockRewardsToken token;
    AegisRewards rewards;
    uint256 amount = 10_000_000_000;

    function setUp() public {
        token = new MockRewardsToken();
        token.faucetTok();
        bytes32 leaf = keccak256(abi.encodePacked(address(this), amount, uint256(0)));
        rewards = new AegisRewards(address(token), leaf);
        token.transfer(address(rewards), 2_000_000_000000);
    }

    function test_claim_epoch0() public {
        bytes32[] memory proof = new bytes32[](0);
        rewards.claim(amount, proof);
        assert(token.balanceOf(address(this)) >= amount);
    }

    function test_double_claim_reverts() public {
        bytes32[] memory proof = new bytes32[](0);
        rewards.claim(amount, proof);
        bool bad;
        try rewards.claim(amount, proof) {} catch { bad = true; }
        assert(bad);
    }

    function test_set_epoch() public {
        bytes32 leaf = keccak256(abi.encodePacked(address(this), amount, uint256(1)));
        rewards.setEpoch(leaf);
        assert(rewards.epoch() == 1);
    }

    function assert(bool cond) internal pure {
        if (!cond) revert("assert failed");
    }
}
