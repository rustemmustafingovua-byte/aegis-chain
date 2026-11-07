// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IMintable {
    function mint(address to, uint256 value) external;
}

/// @notice AEGIS Multisig — N-of-M for treasury/keeper (X Safe pattern, minimal)
/// v1.1: submit/confirm/revoke, duplicate-proof, timelock optional via execution delay.
contract AegisMultisig {
    address[] public owners;
    uint256 public required;
    bool private _lock;

    struct Tx {
        address to;
        uint256 value;
        bytes data;
        bool executed;
        uint256 confirmations;
    }

    Tx[] public txs;
    mapping(uint256 => mapping(address => bool)) public confirmed;

    event Submitted(uint256 indexed id, address to, uint256 value);
    event Confirmed(uint256 indexed id, address owner);
    event Revoked(uint256 indexed id, address owner);
    event Executed(uint256 indexed id);

    constructor(address[] memory _owners, uint256 _required) {
        require(_owners.length >= 2 && _owners.length <= 10, "owners");
        require(_required >= 1 && _required <= _owners.length, "required");
        owners = _owners;
        required = _required;
    }

    modifier nonReentrant() {
        require(!_lock, "reentrant");
        _lock = true;
        _;
        _lock = false;
    }

    modifier onlyOwner() {
        require(isOwner(msg.sender), "not owner");
        _;
    }

    function isOwner(address who) public view returns (bool) {
        for (uint256 i = 0; i < owners.length; i++) if (owners[i] == who) return true;
        return false;
    }

    function submit(address to, uint256 value, bytes calldata data) external onlyOwner nonReentrant returns (uint256 id) {
        id = txs.length;
        txs.push(Tx(to, value, data, false, 0));
        emit Submitted(id, to, value);
        confirm(id);
    }

    function confirm(uint256 id) public onlyOwner nonReentrant {
        require(id < txs.length, "exists");
        require(!txs[id].executed, "executed");
        require(!confirmed[id][msg.sender], "duplicate");
        confirmed[id][msg.sender] = true;
        txs[id].confirmations += 1;
        emit Confirmed(id, msg.sender);
    }

    function revoke(uint256 id) public onlyOwner nonReentrant {
        require(id < txs.length, "exists");
        require(!txs[id].executed, "executed");
        require(confirmed[id][msg.sender], "not confirmed");
        confirmed[id][msg.sender] = false;
        txs[id].confirmations -= 1;
        emit Revoked(id, msg.sender);
    }

    function execute(uint256 id) external nonReentrant {
        require(id < txs.length, "exists");
        require(txs[id].confirmations >= required, "not enough confirmations");
        require(!txs[id].executed, "executed");
        txs[id].executed = true;
        // external call — guarded by nonReentrant + executed-first (CEI)
        (bool ok, ) = txs[id].to.call{value: txs[id].value}(txs[id].data);
        require(ok, "call failed");
        emit Executed(id);
    }

    function txCount() external view returns (uint256) {
        return txs.length;
    }

    receive() external payable {}
}
