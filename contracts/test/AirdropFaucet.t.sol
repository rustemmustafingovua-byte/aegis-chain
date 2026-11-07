// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../AegisFaucet.sol";
import "../AegisAirdrop.sol";

contract MockFaucetToken {
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function faucetTok() external { balanceOf[msg.sender] += 10_000_000_000000; }
    function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; return true; }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
    function transferFrom(address f, address t, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        require(a >= v, "allowance");
        if (a != type(uint256).max) allowance[f][msg.sender] = a - v;
        balanceOf[f] -= v; balanceOf[t] += v; return true;
    }
}

contract AirdropFaucetTest {
    MockFaucetToken token;
    AegisFaucet faucet;
    AegisAirdrop airdrop;
    address who = address(0xBEEF);
    uint256 amount = 10_000_000_000;

    function setUp() public {
        token = new MockFaucetToken();
        token.faucetTok(); // test contract
        faucet = new AegisFaucet(address(token));
        token.transfer(address(faucet), 2_000_000_000000);
        // airdrop: single leaf = test contract / amount, root = leaf (empty proof)
        bytes32 leaf = keccak256(abi.encodePacked(address(this), amount));
        airdrop = new AegisAirdrop(address(token), leaf);
        token.transfer(address(airdrop), 2_000_000_000000);
    }

    function test_faucet_drip_within_cap() public {
        uint256 got = faucet.drip(1_000_000_000);
        assert(got == 1_000_000_000);
    }

    function test_faucet_over_cap_reverts() public {
        faucet.drip(1_000_000_000);
        bool bad;
        try faucet.drip(1) {} catch { bad = true; }
        assert(bad);
    }

    function test_airdrop_single_leaf_claim() public {
        bytes32[] memory proof = new bytes32[](0);
        airdrop.claim(amount, proof);
        assert(token.balanceOf(address(this)) >= amount);
    }

    function assert(bool cond) internal pure {
        if (!cond) revert("assert failed");
    }
}
