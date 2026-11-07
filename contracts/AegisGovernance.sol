// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IGovernanceToken {
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

/// @notice AEGIS Governance — stake-weighted + humanity quorum (mirror core-ts/governance.ts)
/// v1.1: create/vote/tally, humanity score stored on-chain (0-100, set by oracle/keeper), 2/3 threshold.
contract AegisGovernance {
    IGovernanceToken public immutable token;
    address public owner;
    uint256 public constant MIN_STAKE = 10_000_000_000;

    struct Proposal {
        bytes32 id;
        string title;
        string action;
        address proposer;
        uint256 createdAt;
        uint256 votesFor;
        uint256 votesAgainst;
        uint8 status; // 0 open, 1 passed, 2 failed
        uint256 humanityVotes;
    }

    mapping(bytes32 => Proposal) public proposals;
    mapping(bytes32 => mapping(address => bool)) public hasVoted;
    mapping(address => uint256) public humanityScore;
    bool private _lock;

    event Created(bytes32 indexed id, address proposer, string title);
    event Voted(bytes32 indexed id, address voter, bool support, uint256 weight);
    event Tallied(bytes32 indexed id, uint8 status);
    event HumanitySet(address indexed who, uint256 score);

    constructor(address _token) {
        require(_token != address(0), "zero token");
        token = IGovernanceToken(_token);
        owner = msg.sender;
    }

    modifier nonReentrant() {
        require(!_lock, "reentrant");
        _lock = true;
        _;
        _lock = false;
    }

    function setHumanity(address who, uint256 score) external {
        require(msg.sender == owner, "owner only");
        require(score <= 100, "score");
        humanityScore[who] = score;
        emit HumanitySet(who, score);
    }

    function create(bytes32 id, string calldata title, string calldata action) external nonReentrant {
        require(proposals[id].proposer == address(0), "exists");
        require(token.balanceOf(msg.sender) >= MIN_STAKE, "min stake");
        proposals[id] = Proposal(id, title, action, msg.sender, block.timestamp, 0, 0, 0, 0);
        emit Created(id, msg.sender, title);
    }

    function vote(bytes32 id, bool support) external nonReentrant {
        Proposal storage p = proposals[id];
        require(p.status == 0, "not open");
        require(!hasVoted[id][msg.sender], "already voted");
        uint256 weight = token.balanceOf(msg.sender);
        require(weight > 0, "no stake");
        hasVoted[id][msg.sender] = true;
        if (support) p.votesFor += weight; else p.votesAgainst += weight;
        if (humanityScore[msg.sender] >= 70) p.humanityVotes += 1;
        emit Voted(id, msg.sender, support, weight);
    }

    function tally(bytes32 id) external nonReentrant {
        Proposal storage p = proposals[id];
        require(p.status == 0, "not open");
        uint256 total = token.totalSupply();
        uint256 threshold = (total * 2) / 3;
        if (p.votesFor >= threshold && p.humanityVotes >= 2) p.status = 1;
        else if (p.votesAgainst >= threshold) p.status = 2;
        emit Tallied(id, p.status);
    }

    function getProposal(bytes32 id) external view returns (Proposal memory) {
        return proposals[id];
    }
}
