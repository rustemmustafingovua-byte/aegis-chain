// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../AegisMultisig.sol";

contract MultisigTest {
    AegisMultisig ms;
    address owner1 = address(0x1);
    address owner2 = address(0x2);
    address target = address(0xBEEF);

    function setUp() public {
        address[] memory owners = new address[](2);
        owners[0] = owner1;
        owners[1] = owner2;
        ms = new AegisMultisig(owners, 2);
        (bool ok, ) = address(ms).call{value: 1 ether}("");
        assert(ok);
    }

    function test_non_owner_submit_reverts() public {
        // test contract is not an owner (owners are 0x1/0x2)
        bool bad;
        try ms.submit(target, 0.1 ether, "") {} catch { bad = true; }
        assert(bad);
    }

    function test_is_owner() public view {
        assert(ms.isOwner(owner1));
        assert(ms.isOwner(owner2));
        assert(!ms.isOwner(address(0x3)));
    }

    function test_tx_count_zero() public view {
        assert(ms.txCount() == 0);
    }

    function assert(bool cond) internal pure {
        if (!cond) revert("assert failed");
    }
}
