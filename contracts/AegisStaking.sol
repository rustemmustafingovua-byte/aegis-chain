// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Stake {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @notice AEGIS Staking — mirror core-ts/ledger staking (MIN 10k, slash 10%)
/// v1.1: nonReentrant + unstake lock 100 blocks (simulated by timelock in same unit) + slash by owner.
contract AegisStaking {
    IERC20Stake public immutable token;
    uint256 public constant MIN_STAKE = 10_000_000_000; // 10k * 1e6
    uint256 public constant SLASH_BPS = 1000; // 10%
    address public owner;
    bool private _lock;

    mapping(address => uint256) public stake;
    mapping(address => uint256) public unstakeAt;
    mapping(address => uint256) public pendingUnstake;

    event Staked(address indexed who, uint256 amount);
    event Unstaked(address indexed who, uint256 amount, uint256 unlockAt);
    event Unlocked(address indexed who, uint256 amount);
    event Slashed(address indexed who, uint256 amount);

    constructor(address _token) {
        require(_token != address(0), "zero token");
        token = IERC20Stake(_token);
        owner = msg.sender;
    }

    modifier nonReentrant() {
        require(!_lock, "reentrant");
        _lock = true;
        _;
        _lock = false;
    }

    function stakeTokens(uint256 amount) external nonReentrant {
        require(amount >= MIN_STAKE, "min stake 10k");
        require(token.transferFrom(msg.sender, address(this), amount), "transfer failed");
        stake[msg.sender] += amount;
        emit Staked(msg.sender, amount);
    }

    function requestUnstake(uint256 amount) external nonReentrant {
        require(stake[msg.sender] >= amount, "not enough stake");
        require(pendingUnstake[msg.sender] == 0, "pending exists");
        stake[msg.sender] -= amount;
        pendingUnstake[msg.sender] = amount;
        unstakeAt[msg.sender] = block.number + 100; // UNSTAKE_DELAY_BLOCKS mirror
        emit Unstaked(msg.sender, amount, unstakeAt[msg.sender]);
    }

    function unlock() external nonReentrant {
        uint256 amt = pendingUnstake[msg.sender];
        require(amt > 0, "nothing pending");
        require(block.number >= unstakeAt[msg.sender], "locked");
        pendingUnstake[msg.sender] = 0;
        require(token.transfer(msg.sender, amt), "transfer failed");
        emit Unlocked(msg.sender, amt);
    }

    function slash(address who) external nonReentrant {
        require(msg.sender == owner, "owner only");
        uint256 s = stake[who];
        require(s > 0, "no stake");
        uint256 cut = (s * SLASH_BPS) / 10000;
        stake[who] = s - cut;
        // slashed tokens stay in contract (treasury, mainnet: escrow 180d)
        emit Slashed(who, cut);
    }
}
