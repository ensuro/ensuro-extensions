// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {ERC4626CashFlowLender} from "./ERC4626CashFlowLender.sol";
import {IERC721} from "@openzeppelin/contracts/interfaces/IERC721.sol";

/**
 * @title MigrateERC4626CFL
 *
 * @dev Contract used to migrate a CFL to another CFL, enabling the transfer of the owned policy NFTs
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract MigrateERC4626CFL is ERC4626CashFlowLender {
  bytes32 public constant MIGRATE_NFTS_ROLE = keccak256("MIGRATE_NFTS_ROLE");

  address public immutable destinationCFL;
  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(address destinationCFL_) ERC4626CashFlowLender() {
    destinationCFL = destinationCFL_;
  }

  function migratePolicies(uint256[] memory policyIds) external onlyRole(MIGRATE_NFTS_ROLE) {
    IERC721 pool = IERC721(address(_pool()));
    for (uint256 i = 0; i < policyIds.length; ++i) {
      pool.safeTransferFrom(address(this), destinationCFL, policyIds[i]);
    }
  }
}
