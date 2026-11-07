// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20HTLC {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @notice AEGIS HTLC — generic interchain hash-time-lock (Lumen ↔ AEGIS, Base ↔ AEGIS)
/// v1.8: fund/claim/refund, same hashlock both chains, timelock 60s..30d. Mirror BridgeVault but
///   generic token + counterparty field for cross-chain watchers (keeper/htlc-watcher).
contract AegisHTLC {
    struct Lock { address sender; address counterparty; uint256 amount; bytes32 hashlock; uint256 timelock; bool claimed; bool refunded; }
    mapping(bytes32 => Lock) public locks;
    address public owner;
    bool private _lock;

    event Funded(bytes32 indexed id, address sender, uint256 amount, bytes32 hashlock, uint256 timelock);
    event Claimed(bytes32 indexed id);
    event Refunded(bytes32 indexed id);

    constructor() { owner = msg.sender; }

    modifier nonReentrant() {
        require(!_lock, "reentrant");
        _lock = true;
        _;
        _lock = false;
    }

    function fund(IERC20HTLC token, bytes32 id, address counterparty, uint256 amount, bytes32 hashlock, uint256 timelockSec) external nonReentrant {
        require(address(token) != address(0), "zero token");
        require(amount > 0, "zero");
        require(counterparty != address(0), "zero counterparty");
        require(timelockSec >= 60 && timelockSec <= 30 days, "timelock bounds");
        require(locks[id].amount == 0, "exists");
        require(token.transferFrom(msg.sender, address(this), amount), "transfer failed");
        uint256 lockUntil = block.timestamp + timelockSec;
        locks[id] = Lock(msg.sender, counterparty, amount, hashlock, lockUntil, false, false);
        emit Funded(id, msg.sender, amount, hashlock, lockUntil);
    }

    function claim(IERC20HTLC token, bytes32 id, bytes32 secret) external nonReentrant {
        Lock storage l = locks[id];
        require(!l.claimed && !l.refunded, "done");
        require(keccak256(abi.encodePacked(secret)) == l.hashlock, "bad secret");
        l.claimed = true;
        require(token.transfer(l.counterparty, l.amount), "transfer failed");
        emit Claimed(id);
    }

    function refund(IERC20HTLC token, bytes32 id) external nonReentrant {
        Lock storage l = locks[id];
        require(!l.claimed && !l.refunded, "done");
        require(block.timestamp > l.timelock, "timelock");
        l.refunded = true;
        require(token.transfer(l.sender, l.amount), "transfer failed");
        emit Refunded(id);
    }
}
