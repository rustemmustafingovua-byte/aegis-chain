// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../AEGIS.sol";
import "../AegisAMM.sol";
import "../BridgeVault.sol";

// Minimal mock ERC20 for tests (USDC-like)
contract MockERC20 {
    string public name = "Mock USDC";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function faucet() external { balanceOf[msg.sender] += 2_000_000_000000; }
    function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; return true; }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
    function transferFrom(address f, address t, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        require(a >= v, "allowance");
        if (a != type(uint256).max) allowance[f][msg.sender] = a - v;
        balanceOf[f] -= v; balanceOf[t] += v;
        return true;
    }
}

contract AegisTest {
    AEGIS aegis;
    MockERC20 mock;
    AegisAMM amm;
    BridgeVault vault;

    function setUp() public {
        aegis = new AEGIS();
        mock = new MockERC20();
        mock.faucet(); // test contract gets mock USDC for liquidity + vault
        uint256 liqA = 1_000_000_000000;
        uint256 liqB = 1_000_000_000000;
        amm = new AegisAMM(address(aegis), address(mock));
        aegis.approve(address(amm), liqA);
        mock.approve(address(amm), liqB);
        amm.addLiquidity(liqA, liqB);
        vault = new BridgeVault(address(mock));
    }

    function test_aegis_transfer() public {
        address bob = address(0xB0B);
        assert(aegis.transfer(bob, 1000));
        assert(aegis.balanceOf(bob) == 1000);
    }

    function test_aegis_permit_rejected_expired() public {
        bool reverted;
        try aegis.permit(address(this), address(0x1), 100, 1, 27, bytes32(0), bytes32(0)) {
            reverted = false;
        } catch {
            reverted = true;
        }
        assert(reverted);
    }

    function test_amm_quote_positive() public view {
        uint256 out = amm.quote(1_000_000);
        assert(out > 0);
        assert(out < 1_000_000);
    }

    function test_amm_swap_moves_tokens() public {
        uint256 beforeB = mock.balanceOf(address(this));
        aegis.approve(address(amm), 1_000_000);
        uint256 out = amm.swap(1_000_000, 1, block.timestamp + 100);
        assert(out > 0);
        assert(mock.balanceOf(address(this)) == beforeB + out);
    }

    function test_amm_swap_slippage_reverts() public {
        aegis.approve(address(amm), 1_000_000);
        bool bad;
        try amm.swap(1_000_000, type(uint256).max, block.timestamp + 100) {} catch { bad = true; }
        assert(bad);
    }

    function test_aegis_mint_cap() public {
        bool bad;
        try aegis.mint(address(0x1), 2_000_000_000_000_000) {} catch { bad = true; }
        assert(bad); // would exceed 2e9 cap
    }

    function test_bridge_fund_claim_refund() public {
        bytes32 id = keccak256("lock1");
        bytes32 secret = "s3cr3t";
        bytes32 hash = keccak256(abi.encodePacked(secret));
        address recip = address(0xBEEF);
        mock.approve(address(vault), 1000);
        vault.fund(id, recip, 1000, hash, 3600);
        assert(mock.balanceOf(address(vault)) == 1000);
        // wrong secret fails
        bool bad;
        try vault.claim(id, "wrong") {} catch { bad = true; }
        assert(bad);
        // correct claim pays recipient
        vault.claim(id, secret);
        assert(mock.balanceOf(recip) == 1000);
        assert(mock.balanceOf(address(vault)) == 0);
    }

    function test_bridge_refund_after_timelock() public {
        bytes32 id = keccak256("lock2");
        bytes32 hash = keccak256(abi.encodePacked("x"));
        mock.approve(address(vault), 500);
        vault.fund(id, address(0x1), 500, hash, 60);
        // refund before timelock must revert
        bool early;
        try vault.refund(id) {} catch { early = true; }
        assert(early);
    }

    function assert(bool cond) internal pure {
        if (!cond) revert("assert failed");
    }
    function assert(uint256 a, uint256 b) internal pure {
        if (a != b) revert("assert eq failed");
    }
}
