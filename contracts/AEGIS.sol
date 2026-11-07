// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../AEGIS.sol";

/// @notice AEGIS ERC-20 + permit (как Lumen LMN.sol)
/// v1.0: mint cap 2e9 AEGIS (anti-infinite-mint), Mint event, zero checks hardened.
contract AEGIS {
    string public constant name = "AEGIS";
    string public constant symbol = "AEGIS";
    uint8 public constant decimals = 6;
    uint256 public totalSupply = 1_000_000_000_000_000; // 1e9 * 1e6
    uint256 public constant MINT_CAP = 2_000_000_000_000_000; // 2e9 AEGIS hard cap
    address public owner;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;
    bytes32 public constant PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Mint(address indexed to, uint256 value);

    constructor() {
        owner = msg.sender;
        balanceOf[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        require(from != address(0) && to != address(0), "zero");
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(to != address(0), "zero");
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    /// @notice EIP-2612 permit: set allowance via signature (gasless approval)
    function permit(address pOwner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        require(block.timestamp <= deadline, "permit expired");
        require(pOwner != address(0) && spender != address(0), "zero");
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, pOwner, spender, value, nonces[pOwner], deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", block.chainid, address(this), structHash));
        address recovered = ecrecover(digest, v, r, s);
        require(recovered == pOwner && recovered != address(0), "bad sig");
        nonces[pOwner] += 1;
        allowance[pOwner][spender] = value;
        emit Approval(pOwner, spender, value);
    }

    /// @notice owner can mint up to hard cap (testnet / treasury). Callers must enforce governance (humanity quorum).
    function mint(address to, uint256 value) external {
        require(msg.sender == owner, "owner only");
        require(to != address(0), "zero");
        require(totalSupply + value <= MINT_CAP, "cap");
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
        emit Mint(to, value);
    }
}
