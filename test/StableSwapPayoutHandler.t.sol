// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import "forge-std/Test.sol";

import {StableSwapPayoutHandler} from "contracts/StableSwapPayoutHandler.sol";
import {IPolicyHolder} from "@ensuro/core/contracts/interfaces/IPolicyHolder.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

contract TestStableSwapPayoutHandler is Test {
  StableSwapPayoutHandler payoutHandler;

  function setUp() public {
    payoutHandler = new StableSwapPayoutHandler(IERC20Metadata(address(20)));
  }

  function test_SupportsInterface() public {
    assertTrue(payoutHandler.supportsInterface(type(IPolicyHolder).interfaceId));
    assertTrue(payoutHandler.supportsInterface(type(IERC721).interfaceId));
  }
}
