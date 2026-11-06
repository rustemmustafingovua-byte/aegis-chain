// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Vault {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @notice AEGIS Bridge Vault — HTLC vault на Base (mirror core-ts/bridge.ts)
/// v0.8: ERC20 (USDC) vault instead of native ETH — matches Base bridge design.
/// fund: user locks USDC with hashlock; claim: keeper reveals secret on AEGIS chain side.
contract BridgeVault {
    struct Lock { address sender; address recipient; uint256 amount; bytes32 hashlock; uint256 timelock; bool claimed; bool refunded; }
    mapping(bytes32 => Lock) public locks;
    address public owner; // keeper operator
    IERC20Vault public immutable token; // USDC
    event Funded(bytes32 indexed id, address sender, uint256 amount, bytes32 hashlock, uint256 timelock);
    event Claimed(bytes32 indexed id);
    event Refunded(bytes32 indexed id);
    constructor(address _token) { owner = msg.sender; token = IERC20Vault(_token); }
    function fund(bytes32 id, address recipient, uint256 amount, bytes32 hashlock, uint256 timelockSec) external {
        require(amount > 0, "zero");
        require(locks[id].amount == 0, "exists");
        require(token.transferFrom(msg.sender, address(this), amount), "transfer failed");
        uint256 lockUntil = block.timestamp + timelockSec;
        locks[id] = Lock({sender: msg.sender, recipient: recipient, amount: amount, hashlock: hashlock, timelock: lockUntil, claimed: false, refunded: false});
        emit Funded(id, msg.sender, amount, hashlock, lockUntil);
    }
    function claim(bytes32 id, bytes32 secret) external {
        Lock storage l = locks[id];
        require(!l.claimed && !l.refunded, "done");
        require(keccak256(abi.encodePacked(secret)) == l.hashlock, "bad secret");
        l.claimed = true;
        require(token.transfer(l.recipient, l.amount), "transfer failed");
        emit Claimed(id);
    }
    function refund(bytes32 id) external {
        Lock storage l = locks[id];
        require(!l.claimed && !l.refunded, "done");
        require(block.timestamp > l.timelock, "timelock");
        l.refunded = true;
        require(token.transfer(l.sender, l.amount), "transfer failed");
        emit Refunded(id);
    }
}
