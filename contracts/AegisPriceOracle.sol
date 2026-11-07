// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPriceAMM {
    function reserveA() external view returns (uint256);
    function reserveB() external view returns (uint256);
}

/// @notice AEGIS Price Oracle — TWAP over AMM reserves (keeper updates, anyone reads)
/// v1.11: accumulator: price*dt sum, window 300s. Keeper calls update() per block.
contract AegisPriceOracle {
    IPriceAMM public immutable pool;
    address public owner;
    uint256 public lastUpdate;
    uint256 public cumulative; // sum(price * dt)
    uint256 public lastPrice;

    event Updated(uint256 price, uint256 cumulative);

    constructor(address _pool) {
        require(_pool != address(0), "zero pool");
        pool = IPriceAMM(_pool);
        owner = msg.sender;
        lastUpdate = block.timestamp;
        lastPrice = _price();
    }

    function _price() internal view returns (uint256) {
        uint256 a = pool.reserveA();
        uint256 b = pool.reserveB();
        if (a == 0) return 0;
        return (b * 1e18) / a; // 1e18 scaled
    }

    function update() external {
        uint256 nowTs = block.timestamp;
        uint256 dt = nowTs - lastUpdate;
        if (dt == 0) return;
        uint256 price = _price();
        cumulative += price * dt;
        lastPrice = price;
        lastUpdate = nowTs;
        emit Updated(price, cumulative);
    }

    /// @notice TWAP over last `windowSec` (seconds). Uses cumulative — caller helps with old cumulative.
    function twap(uint256 cumulativeOld, uint256 tsOld, uint256 windowSec) external view returns (uint256) {
        require(block.timestamp > tsOld, "old ts");
        uint256 current = cumulative + (lastPrice * (block.timestamp - lastUpdate));
        uint256 dt = block.timestamp - tsOld;
        require(dt >= windowSec && dt > 0, "window");
        return (current - cumulativeOld) / dt;
    }

    function spot() external view returns (uint256) {
        return _price();
    }
}
