// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice AEGIS Bridge Vault — HTLC vault на Base (mirror core-ts/bridge.ts)
/// fund: user locks USDC with hashlock; claim: keeper reveals secret on AEGIS chain side.
contract BridgeVault {
    struct Lock { address sender; address recipient; uint256 amount; bytes32 hashlock; uint256 timelock; bool claimed; bool refunded; }
    mapping(bytes32 => Lock) public locks;
    address public owner; // keeper operator
    event Funded(bytes32 indexed id, address sender, uint256 amount, bytes32 hashlock, uint256 timelock);
    event Claimed(bytes32 indexed id);
    event Refunded(bytes32 indexed id);
    constructor() { owner = msg.sender; }
    function fund(bytes32 id, address recipient, uint256 amount, bytes32 hashlock, uint256 timelockSec) external payable {
        require(msg.value == amount, "amount mismatch");
        require(locks[id].amount == 0, "exists");
        locks[id] = Lock({sender: msg.sender, recipient: recipient, amount: amount, hashlock: hashlock, timelock: block.timestamp + timelockSec, claimed: false, refunded: false});
        emit Funded(id, msg.sender, amount, hashlock, block.timestamp + timelockSec);
    }
    function claim(bytes32 id, bytes32 secret) external {
        Lock storage l = locks[id];
        require(!l.claimed && !l.refunded, "done");
        require(keccak256(abi.encodePacked(secret)) == l.hashlock, "bad secret");
        l.claimed = true;
        (bool ok, ) = payable(l.recipient).call{value: l.amount}("");
        require(ok, "transfer failed");
        emit Claimed(id);
    }
    function refund(bytes32 id) external {
        Lock storage l = locks[id];
        require(!l.claimed && !l.refunded, "done");
        require(block.timestamp > l.timelock, "timelock");
        l.refunded = true;
        (bool ok, ) = payable(l.sender).call{value: l.amount}("");
        require(ok, "transfer failed");
        emit Refunded(id);
    }
}
