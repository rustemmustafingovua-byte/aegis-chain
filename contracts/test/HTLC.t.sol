// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../AegisHTLC.sol";

contract MockHTLCToken {
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

contract HTLCTest {
    MockHTLCToken token;
    AegisHTLC htlc;

    function setUp() public {
        token = new MockHTLCToken();
        token.faucetTok();
        htlc = new AegisHTLC();
    }

    function test_fund_claim() public {
        bytes32 id = keccak256("ic1");
        bytes32 secret = "s3cr3t";
        bytes32 hash = keccak256(abi.encodePacked(secret));
        address cp = address(0xBEEF);
        token.approve(address(htlc), 1000);
        htlc.fund(IERC20HTLC(address(token)), id, cp, 1000, hash, 3600);
        assert(token.balanceOf(address(htlc)) == 1000);
        htlc.claim(IERC20HTLC(address(token)), id, secret);
        assert(token.balanceOf(cp) == 1000);
    }

    function test_wrong_secret_reverts() public {
        bytes32 id = keccak256("ic2");
        token.approve(address(htlc), 1000);
        htlc.fund(IERC20HTLC(address(token)), id, address(0x1), 1000, keccak256(abi.encodePacked("x")), 3600);
        bool bad;
        try htlc.claim(IERC20HTLC(address(token)), id, "wrong") {} catch { bad = true; }
        assert(bad);
    }

    function assert(bool cond) internal pure {
        if (!cond) revert("assert failed");
    }
}
