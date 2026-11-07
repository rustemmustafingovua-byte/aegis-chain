// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Rewards {
    function transfer(address to, uint256 value) external returns (bool);
}

/// @notice AEGIS Rewards — Merkle rewards distributor для валидаторов (per epoch)
/// v1.7: keeper публикует epoch root (validtor payouts), валидатор claim. Один claim на epoch.
contract AegisRewards {
    IERC20Rewards public immutable token;
    bytes32 public epochRoot;
    uint256 public epoch;
    address public owner;
    mapping(uint256 => mapping(address => bool)) public claimed;
    bool private _lock;

    event EpochRootSet(uint256 indexed epoch, bytes32 root);
    event Claimed(uint256 indexed epoch, address indexed who, uint256 amount);

    constructor(address _token, bytes32 _root) {
        require(_token != address(0), "zero token");
        token = IERC20Rewards(_token);
        epochRoot = _root;
        epoch = 0;
        owner = msg.sender;
    }

    modifier nonReentrant() {
        require(!_lock, "reentrant");
        _lock = true;
        _;
        _lock = false;
    }

    function setEpoch(bytes32 root) external nonReentrant {
        require(msg.sender == owner, "owner only");
        epoch += 1;
        epochRoot = root;
        emit EpochRootSet(epoch, root);
    }

    function claim(uint256 amount, bytes32[] calldata proof) external nonReentrant {
        require(!claimed[epoch][msg.sender], "already claimed this epoch");
        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, amount, epoch));
        require(_verify(proof, leaf), "bad proof");
        claimed[epoch][msg.sender] = true;
        require(token.transfer(msg.sender, amount), "transfer failed");
        emit Claimed(epoch, msg.sender, amount);
    }

    function _verify(bytes32[] calldata proof, bytes32 leaf) internal view returns (bool) {
        bytes32 node = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            if (node <= p) node = keccak256(abi.encodePacked(node, p));
            else node = keccak256(abi.encodePacked(p, node));
        }
        return node == epochRoot;
    }
}
