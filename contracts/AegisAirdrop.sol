// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Airdrop {
    function transfer(address to, uint256 value) external returns (bool);
}

/// @notice AEGIS Airdrop — Merkle distributor для ранних валидаторов (snapshot из цепи)
/// v1.6: leaf = keccak256(abi.encodePacked(account, amount)), root стоит в сторедже, claim once.
contract AegisAirdrop {
    IERC20Airdrop public immutable token;
    bytes32 public merkleRoot;
    address public owner;
    mapping(address => bool) public claimed;
    bool private _lock;

    event Claimed(address indexed who, uint256 amount);
    event RootSet(bytes32 root);

    constructor(address _token, bytes32 _root) {
        require(_token != address(0), "zero token");
        token = IERC20Airdrop(_token);
        merkleRoot = _root;
        owner = msg.sender;
    }

    modifier nonReentrant() {
        require(!_lock, "reentrant");
        _lock = true;
        _;
        _lock = false;
    }

    function setRoot(bytes32 root) external nonReentrant {
        require(msg.sender == owner, "owner only");
        merkleRoot = root;
        emit RootSet(root);
    }

    function claim(uint256 amount, bytes32[] calldata proof) external nonReentrant {
        require(!claimed[msg.sender], "already claimed");
        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, amount));
        require(_verify(proof, leaf), "bad proof");
        claimed[msg.sender] = true;
        require(token.transfer(msg.sender, amount), "transfer failed");
        emit Claimed(msg.sender, amount);
    }

    function _verify(bytes32[] calldata proof, bytes32 leaf) internal view returns (bool) {
        bytes32 node = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            if (node <= p) node = keccak256(abi.encodePacked(node, p));
            else node = keccak256(abi.encodePacked(p, node));
        }
        return node == merkleRoot;
    }
}
