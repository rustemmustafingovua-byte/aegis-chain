// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice AEGIS AMM — constant product x*y=k, 0.30% fee (как LumenAMM.sol)
/// v1.0: CEI (state before external calls) + reentrancy lock + slippage/deadline + owner removeLiquidity.
contract AegisAMM {
    uint256 public reserveA; // AEGIS
    uint256 public reserveB; // USDC
    uint256 public constant FEE_BPS = 30; // 0.30%
    address public owner;
    IERC20 public immutable tokenA;
    IERC20 public immutable tokenB;
    bool private _lock;

    event AddLiquidity(address indexed who, uint256 a, uint256 b);
    event RemoveLiquidity(address indexed who, uint256 a, uint256 b);
    event Swap(address indexed who, uint256 amountIn, uint256 out);

    constructor(address _tokenA, address _tokenB) {
        require(_tokenA != address(0) && _tokenB != address(0), "zero token");
        owner = msg.sender;
        tokenA = IERC20(_tokenA);
        tokenB = IERC20(_tokenB);
    }

    modifier nonReentrant() {
        require(!_lock, "reentrant");
        _lock = true;
        _;
        _lock = false;
    }

    function addLiquidity(uint256 a, uint256 b) external nonReentrant {
        require(msg.sender == owner, "owner");
        require(a > 0 && b > 0, "zero");
        // CEI: effects before interactions (revert rolls back caches)
        reserveA += a;
        reserveB += b;
        require(tokenA.transferFrom(msg.sender, address(this), a), "transferA failed");
        require(tokenB.transferFrom(msg.sender, address(this), b), "transferB failed");
        emit AddLiquidity(msg.sender, a, b);
    }

    function removeLiquidity(uint256 a, uint256 b) external nonReentrant {
        require(msg.sender == owner, "owner");
        require(a <= reserveA && b <= reserveB, "insufficient reserves");
        reserveA -= a;
        reserveB -= b;
        require(tokenA.transfer(msg.sender, a), "transferA failed");
        require(tokenB.transfer(msg.sender, b), "transferB failed");
        emit RemoveLiquidity(msg.sender, a, b);
    }

    function quote(uint256 amountIn) public view returns (uint256) {
        require(reserveA > 0 && reserveB > 0, "no liquidity");
        uint256 fee = (amountIn * FEE_BPS) / 10000;
        uint256 eff = amountIn - fee;
        return (reserveB * eff) / (reserveA + eff);
    }

    /// @notice swap with slippage + deadline (anti-MEV / anti-stuck)
    function swap(uint256 amountIn, uint256 minOut, uint256 deadline) external nonReentrant returns (uint256 out) {
        require(block.timestamp <= deadline, "expired");
        out = quote(amountIn);
        require(out >= minOut && out > 0, "slippage");
        // CEI: reserve effects before token moves
        reserveA += amountIn;
        reserveB -= out;
        require(tokenA.transferFrom(msg.sender, address(this), amountIn), "transferA failed");
        require(tokenB.transfer(msg.sender, out), "transferB failed");
        emit Swap(msg.sender, amountIn, out);
    }

    /// @notice legacy overload — tests may call swap(uint256); defaults to no slippage guard
    function swapLegacy(uint256 amountIn) external returns (uint256 out) {
        out = quote(amountIn);
        require(out > 0, "zero");
        reserveA += amountIn;
        reserveB -= out;
        require(tokenA.transferFrom(msg.sender, address(this), amountIn), "transferA failed");
        require(tokenB.transfer(msg.sender, out), "transferB failed");
        emit Swap(msg.sender, amountIn, out);
    }
}
