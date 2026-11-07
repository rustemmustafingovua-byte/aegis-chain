// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../AegisPriceOracle.sol";
import "../AegisAMM.sol";

contract OracleTest {
    AegisAMM amm;
    AegisPriceOracle oracle;

    function setUp() public {
        // dummy AMM with zero tokens — oracle spot reads reserves (0) → price 0, no revert
        amm = new AegisAMM(address(0x1), address(0x2));
        oracle = new AegisPriceOracle(address(amm));
    }

    function test_spot_zero_when_empty() public view {
        // empty AMM reserves -> price 0, no revert
        assert(oracle.spot() == 0);
    }

    function assert(bool cond) internal pure {
        if (!cond) revert("assert failed");
    }
}
