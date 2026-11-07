// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice AEGIS Timelock — задержка исполнения на 24h после подтверждения Multisig
/// v1.3: queue → execute после delay, cancel by admin. Prevents rushed treasury drain.
contract AegisTimelock {
    address public admin;
    uint256 public delay = 24 hours;
    bool private _lock;

    struct Op {
        address to;
        uint256 value;
        bytes data;
        uint256 eta;
        bool done;
        bool cancelled;
    }

    Op[] public ops;

    event Queued(uint256 indexed id, address to, uint256 value, uint256 eta);
    event Executed(uint256 indexed id);
    event Cancelled(uint256 indexed id);

    constructor() {
        admin = msg.sender;
    }

    modifier nonReentrant() {
        require(!_lock, "reentrant");
        _lock = true;
        _;
        _lock = false;
    }

    function queue(address to, uint256 value, bytes calldata data) external nonReentrant returns (uint256 id) {
        require(msg.sender == admin, "admin only");
        require(to != address(0), "zero");
        id = ops.length;
        ops.push(Op(to, value, data, block.timestamp + delay, false, false));
        emit Queued(id, to, value, ops[id].eta);
    }

    function execute(uint256 id) external nonReentrant {
        require(id < ops.length, "exists");
        Op storage op = ops[id];
        require(!op.done && !op.cancelled, "done");
        require(block.timestamp >= op.eta, "not yet");
        op.done = true;
        (bool ok, ) = op.to.call{value: op.value}(op.data);
        require(ok, "call failed");
        emit Executed(id);
    }

    function cancel(uint256 id) external nonReentrant {
        require(msg.sender == admin, "admin only");
        require(id < ops.length, "exists");
        ops[id].cancelled = true;
        emit Cancelled(id);
    }

    function opCount() external view returns (uint256) {
        return ops.length;
    }

    receive() external payable {}
}
