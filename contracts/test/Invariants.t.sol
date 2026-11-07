// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../AEGIS.sol";
import "../AegisAMM.sol";

// Minimal mock for invariants
contract MockERC20Inv {
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

/// @notice Conservation invariants as deterministic sequence tests (forge-std free).
/// Proves: balances track reserves, supply within cap, k monotonic across many swaps.
contract InvariantsTest {
    AEGIS aegis;
    MockERC20Inv mock;
    AegisAMM amm;

    function setUp() public {
        aegis = new AEGIS();
        mock = new MockERC20Inv();
        mock.faucet();
        amm = new AegisAMM(address(aegis), address(mock));
        uint256 liqA = 1_000_000_000000;
        uint256 liqB = 1_000_000_000000;
        aegis.approve(address(amm), liqA);
        mock.approve(address(amm), liqB);
        amm.addLiquidity(liqA, liqB);
    }

    function test_conservation_after_swap_sequence() public {
        for (uint256 i = 0; i < 50; i++) {
            uint256 amt = 1_000_000 + (i * 10_000_000) % 10_000_000;
            aegis.approve(address(amm), amt);
            amm.swap(amt, 1, block.timestamp + 100);
            assert(aegis.balanceOf(address(amm)) == amm.reserveA());
            assert(mock.balanceOf(address(amm)) == amm.reserveB());
            assert(aegis.totalSupply() <= aegis.MINT_CAP());
            assert(amm.reserveA() > 0 && amm.reserveB() > 0);
        }
    }

    function test_k_never_decreases_after_fees() public {
        uint256 k0 = amm.reserveA() * amm.reserveB();
        for (uint256 i = 0; i < 20; i++) {
            uint256 amt = 10_000_000;
            aegis.approve(address(amm), amt);
            amm.swap(amt, 1, block.timestamp + 100);
            uint256 k1 = amm.reserveA() * amm.reserveB();
            assert(k1 >= k0);
            k0 = k1;
        }
    }
}
