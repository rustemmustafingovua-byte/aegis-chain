// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice AEGIS Paymaster — gasless sponsor for intent-bound txs (humanity-gated)
/// v1.4: sponsor(user) pays daily allowance, owner refills, per-user cap, nonReentrant.
contract AegisPaymaster {
    address public owner;
    uint256 public dailyCap = 1_000_000; // 1 AEGIS per user per day (base units)
    mapping(address => uint256) public spentToday;
    mapping(address => uint256) public lastDay;
    bool private _lock;

    event Sponsored(address indexed user, uint256 amount);
    event Refilled(uint256 amount);
    event CapSet(uint256 cap);

    constructor() {
        owner = msg.sender;
    }

    modifier nonReentrant() {
        require(!_lock, "reentrant");
        _lock = true;
        _;
        _lock = false;
    }

    receive() external payable {}

    function refill() external payable nonReentrant {
        require(msg.sender == owner, "owner only");
        emit Refilled(msg.value);
    }

    function setCap(uint256 cap) external nonReentrant {
        require(msg.sender == owner, "owner only");
        dailyCap = cap;
        emit CapSet(cap);
    }

    /// @notice sponsor up to dailyCap for user (reset each block day approx: lastDay bucket)
    function sponsor(address user, uint256 amount) external nonReentrant returns (bool) {
        require(msg.sender == owner, "owner only");
        uint256 day = block.timestamp / 1 days;
        if (lastDay[user] != day) {
            lastDay[user] = day;
            spentToday[user] = 0;
        }
        require(spentToday[user] + amount <= dailyCap, "cap exceeded");
        require(address(this).balance >= amount, "insufficient funds");
        spentToday[user] += amount;
        (bool ok, ) = user.call{value: amount}("");
        require(ok, "transfer failed");
        emit Sponsored(user, amount);
        return true;
    }
}
