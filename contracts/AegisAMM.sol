// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice AEGIS AMM — constant product x*y=k, 0.30% fee (как LumenAMM.sol)
/// v0.8: actually moves ERC20 tokens (previously only updated reserve vars — unusable on-chain).
contract AegisAMM {
    uint256 public reserveA; // AEGIS
    uint256 public reserveB; // USDC
    uint256 public constant FEE_BPS = 30; // 0.30%
    address public owner;
    IERC20 public immutable tokenA;
    IERC20 public immutable tokenB;

    event AddLiquidity(address indexed who, uint256 a, uint256 b);
    event Swap(address indexed who, uint256 amountIn, uint256 out);

    constructor(address _tokenA, address _tokenB) {
        owner = msg.sender;
        tokenA = IERC20(_tokenA);
        tokenB = IERC20(_tokenB);
    }

    function addLiquidity(uint256 a, uint256 b) external {
        require(msg.sender == owner, "owner");
        require(a > 0 && b > 0, "zero");
        require(tokenA.transferFrom(msg.sender, address(this), a), "transferA failed");
        require(tokenB.transferFrom(msg.sender, address(this), b), "transferB failed");
        reserveA += a;
        reserveB += b;
        emit AddLiquidity(msg.sender, a, b);
    }

    function quote(uint256 amountIn) public view returns (uint256) {
        require(reserveA > 0 && reserveB > 0, "no liquidity");
        uint256 fee = (amountIn * FEE_BPS) / 10000;
        uint256 eff = amountIn - fee;
        return (reserveB * eff) / (reserveA + eff);
    }

    function swap(uint256 amountIn) external returns (uint256 out) {
        out = quote(amountIn);
        require(out > 0, "zero");
        // pull AEGIS in, push USDC out
        require(tokenA.transferFrom(msg.sender, address(this), amountIn), "transferA failed");
        require(tokenB.transfer(msg.sender, out), "transferB failed");
        reserveA += amountIn;
        reserveB -= out;
        emit Swap(msg.sender, amountIn, out);
    }
}
