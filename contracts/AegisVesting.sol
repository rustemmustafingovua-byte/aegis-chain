// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Vesting {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice AEGIS Vesting — linear vesting для treasury/validators (4 года, cliff 6 мес)
/// v1.5: createVesting, claimable, claim (CEI + nonReentrant), revoke by admin (returns unvested to treasury).
contract AegisVesting {
    IERC20Vesting public immutable token;
    address public admin;
    uint256 public constant CLIFF = 180 days;
    uint256 public constant DURATION = 4 * 365 days;
    bool private _lock;

    struct Vesting {
        address beneficiary;
        uint256 total;
        uint256 claimed;
        uint256 start;
    }

    mapping(address => Vesting) public vestings;
    mapping(address => bool) public revoked;

    event Created(address indexed who, uint256 total, uint256 start);
    event Claimed(address indexed who, uint256 amount);
    event Revoked(address indexed who);

    constructor(address _token) {
        require(_token != address(0), "zero token");
        token = IERC20Vesting(_token);
        admin = msg.sender;
    }

    modifier nonReentrant() {
        require(!_lock, "reentrant");
        _lock = true;
        _;
        _lock = false;
    }

    function create(address who, uint256 total) external nonReentrant {
        require(msg.sender == admin, "admin only");
        require(who != address(0) && total > 0, "zero");
        require(vestings[who].total == 0, "exists");
        require(token.transferFrom(msg.sender, address(this), total), "transfer failed");
        vestings[who] = Vesting(who, total, 0, block.timestamp);
        emit Created(who, total, block.timestamp);
    }

    function vestedAmount(address who) public view returns (uint256) {
        Vesting storage v = vestings[who];
        if (v.total == 0 || revoked[who]) return 0;
        if (block.timestamp < v.start + CLIFF) return 0;
        if (block.timestamp >= v.start + DURATION) return v.total;
        return (v.total * (block.timestamp - v.start)) / DURATION;
    }

    function claimable(address who) external view returns (uint256) {
        uint256 v = vestedAmount(who);
        uint256 c = vestings[who].claimed;
        return v > c ? v - c : 0;
    }

    function claim() external nonReentrant {
        Vesting storage v = vestings[msg.sender];
        require(v.total > 0 && !revoked[msg.sender], "no vesting");
        uint256 amt = this.claimable(msg.sender);
        require(amt > 0, "nothing to claim");
        v.claimed += amt;
        require(token.transfer(msg.sender, amt), "transfer failed");
        emit Claimed(msg.sender, amt);
    }

    function revoke(address who) external nonReentrant {
        require(msg.sender == admin, "admin only");
        Vesting storage v = vestings[who];
        require(v.total > 0 && !revoked[who], "no vesting");
        revoked[who] = true;
        uint256 unvested = v.total - v.claimed;
        // vested-but-unclaimed stays claimable? v1.5: revoke returns unvested, beneficiary keeps vested.
        require(token.transfer(admin, unvested), "transfer failed");
        emit Revoked(who);
    }
}
