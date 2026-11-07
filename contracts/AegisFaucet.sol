// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Faucet {
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice AEGIS Faucet — testnet faucet (Base Sepolia), rate-limited per address per day.
/// v1.6: owner refill, dailyCap per user, nonReentrant. Mainnet: disabled (use real bridge).
contract AegisFaucet {
    IERC20Faucet public immutable token;
    address public owner;
    uint256 public dailyCap = 1_000_000_000; // 1000 AEGIS/day/user
    mapping(address => uint256) public spentToday;
    mapping(address => uint256) public lastDay;
    bool private _lock;

    event Drip(address indexed who, uint256 amount);
    event Refilled(uint256 amount);

    constructor(address _token) {
        require(_token != address(0), "zero token");
        token = IERC20Faucet(_token);
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

    function drip(uint256 amount) external nonReentrant returns (uint256) {
        require(amount > 0 && amount <= dailyCap, "cap");
        uint256 day = block.timestamp / 1 days;
        if (lastDay[msg.sender] != day) {
            lastDay[msg.sender] = day;
            spentToday[msg.sender] = 0;
        }
        require(spentToday[msg.sender] + amount <= dailyCap, "daily cap");
        require(token.balanceOf(address(this)) >= amount, "insufficient funds");
        spentToday[msg.sender] += amount;
        require(token.transfer(msg.sender, amount), "transfer failed");
        emit Drip(msg.sender, amount);
        return amount;
    }
}
