// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../AegisStaking.sol";
import "../AegisGovernance.sol";

// Minimal mock (reuse pattern from Aegis.t.sol)
contract MockERC20Staking {
    uint8 public decimals = 6;
    uint256 public totalSupply = 1_000_000_000_000_000;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function faucet() external { balanceOf[msg.sender] += 2_000_000_000000; }
    function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; return true; }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
    function transferFrom(address f, address t, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        require(a >= v, "allowance");
        if (a != type(uint256).max) allowance[f][msg.sender] = a - v;
        balanceOf[f] -= v; balanceOf[t] += v; return true;
    }
}

contract StakingGovernanceTest {
    MockERC20Staking token;
    AegisStaking staking;
    AegisGovernance gov;

    function setUp() public {
        token = new MockERC20Staking();
        token.faucet(); // test contract
        staking = new AegisStaking(address(token));
        gov = new AegisGovernance(address(token));
        gov.setHumanity(address(this), 80);
    }

    function test_stake_and_unstake_lock() public {
        uint256 amt = 10_000_000_000; // 10k
        token.approve(address(staking), amt);
        staking.stakeTokens(amt);
        assert(staking.stake(address(this)) == amt);
        staking.requestUnstake(amt);
        assert(staking.stake(address(this)) == 0);
        assert(staking.pendingUnstake(address(this)) == amt);
        // unlock too early must revert (100 blocks)
        bool bad;
        try staking.unlock() {} catch { bad = true; }
        assert(bad);
    }

    function test_slash() public {
        uint256 amt = 10_000_000_000;
        token.approve(address(staking), amt);
        staking.stakeTokens(amt);
        staking.slash(address(this));
        assert(staking.stake(address(this)) < amt);
    }

    function test_gov_vote_and_tally() public {
        bytes32 id = keccak256("prop1");
        gov.create(id, "upgrade", "fee:30");
        gov.vote(id, true);
        // total = 1e15, test contract holds 2e12 only — below 2/3, so stays open
        gov.tally(id);
        AegisGovernance.Proposal memory p = gov.getProposal(id);
        assert(p.status == 0);
        assert(p.humanityVotes == 1);
    }

    function assert(bool cond) internal pure {
        if (!cond) revert("assert failed");
    }
}
