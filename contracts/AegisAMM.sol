// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice AEGIS AMM — constant product x*y=k, 0.30% fee (как LumenAMM.sol)
contract AegisAMM {
    uint256 public reserveA; // AEGIS
    uint256 public reserveB; // USDC
    uint256 public constant FEE_BPS = 30; // 0.30%
    address public owner;
    constructor() { owner = msg.sender; }
    function addLiquidity(uint256 a, uint256 b) external {
        require(msg.sender == owner, "owner");
        reserveA += a; reserveB += b;
    }
    function quote(uint256 amountIn) public view returns (uint256) {
        uint256 fee = (amountIn * FEE_BPS) / 10000;
        uint256 eff = amountIn - fee;
        return (reserveB * eff) / (reserveA + eff);
    }
    function swap(uint256 amountIn) external returns (uint256 out) {
        out = quote(amountIn);
        require(out > 0, "zero");
        reserveA += amountIn;
        reserveB -= out;
    }
}
