// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Vault {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @notice AEGIS Bridge Vault — HTLC vault на Base (mirror core-ts/bridge.ts)
/// v1.0: ERC20 (USDC) + reentrancy lock + timelock bounds (60s..30d) + zero recipient guard.
contract BridgeVault {
    struct Lock { address sender; address recipient; uint256 amount; bytes32 hashlock; uint256 timelock; bool claimed; bool refunded; }
    mapping(bytes32 => Lock) public locks;
    address public owner; // keeper operator
    IERC20Vault public immutable token; // USDC
    bool private _lock;
    uint256 public constant MIN_TIMELOCK = 60;
    uint256 public constant MAX_TIMELOCK = 30 days;

    event Funded(bytes32 indexed id, address sender, uint256 amount, bytes32 hashlock, uint256 timelock);
    event Claimed(bytes32 indexed id);
    event Refunded(bytes32 indexed id);

    constructor(address _token) {
        require(_token != address(0), "zero token");
        owner = msg.sender;
        token = IERC20Vault(_token);
    }

    modifier nonReentrant() {
        require(!_lock, "reentrant");
        _lock = true;
        _;
        _lock = false;
    }

    function fund(bytes32 id, address recipient, uint256 amount, bytes32 hashlock, uint256 timelockSec) external nonReentrant {
        require(amount > 0, "zero");
        require(recipient != address(0), "zero recipient");
        require(timelockSec >= MIN_TIMELOCK && timelockSec <= MAX_TIMELOCK, "timelock bounds");
        require(locks[id].amount == 0, "exists");
        require(token.transferFrom(msg.sender, address(this), amount), "transfer failed");
        uint256 lockUntil = block.timestamp + timelockSec;
        locks[id] = Lock({sender: msg.sender, recipient: recipient, amount: amount, hashlock: hashlock, timelock: lockUntil, claimed: false, refunded: false});
        emit Funded(id, msg.sender, amount, hashlock, lockUntil);
    }

    function claim(bytes32 id, bytes32 secret) external nonReentrant {
        Lock storage l = locks[id];
        require(!l.claimed && !l.refunded, "done");
        require(keccak256(abi.encodePacked(secret)) == l.hashlock, "bad secret");
        l.claimed = true;
        require(token.transfer(l.recipient, l.amount), "transfer failed");
        emit Claimed(id);
    }

    function refund(bytes32 id) external nonReentrant {
        Lock storage l = locks[id];
        require(!l.claimed && !l.refunded, "done");
        require(block.timestamp > l.timelock, "timelock");
        require(msg.sender == l.sender || msg.sender == owner, "not sender");
        l.refunded = true;
        require(token.transfer(l.sender, l.amount), "transfer failed");
        emit Refunded(id);
    }
}
