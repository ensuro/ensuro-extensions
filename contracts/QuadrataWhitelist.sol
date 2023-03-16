// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {LPManualWhitelist} from "@ensuro/core/contracts/LPManualWhitelist.sol";
import {IPolicyPool} from "@ensuro/core/contracts/interfaces/IPolicyPool.sol";
import {PolicyPoolComponent} from "@ensuro/core/contracts/PolicyPoolComponent.sol";

import {IQuadReader} from "@quadrata/contracts/interfaces/IQuadReader.sol";
import {IQuadPassportStore} from "@quadrata/contracts/interfaces/IQuadPassportStore.sol";
import {QuadReaderUtils} from "@quadrata/contracts/utility/QuadReaderUtils.sol";

contract QuadrataWhitelist is LPManualWhitelist {
  using QuadReaderUtils for bytes32;

  bytes32 public constant QUADRATA_WHITELIST_ROLE = keccak256("QUADRATA_WHITELIST_ROLE");

  IQuadReader internal _reader;

  WhitelistStatus internal _whitelistMode;

  event QuadrataWhitelistModeChanged(WhitelistStatus newMode);

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(IPolicyPool policyPool_) LPManualWhitelist(policyPool_) {}

  /**
   *
   * @param defaultStatus The default status to use for undefined whitelist status
   * @param quadrataWhitelistMode The whitelist status to be used when whitelisting with quadrata
   * @param reader The QuadReader to be used
   */
  function initializeQ(
    WhitelistStatus calldata defaultStatus,
    WhitelistStatus calldata quadrataWhitelistMode,
    IQuadReader reader
  ) public initializer {
    __QuadrataWhitelist_init(defaultStatus, quadrataWhitelistMode, reader);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __QuadrataWhitelist_init(
    WhitelistStatus calldata defaultStatus,
    WhitelistStatus calldata quadrataWhitelistMode,
    IQuadReader reader
  ) internal onlyInitializing {
    __LPManualWhitelist_init(defaultStatus);
    __QuadrataWhitelist_init_unchained(quadrataWhitelistMode, reader);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __QuadrataWhitelist_init_unchained(
    WhitelistStatus calldata quadrataWhitelistMode,
    IQuadReader reader
  ) internal onlyInitializing {
    _reader = reader;
    _whitelistMode = quadrataWhitelistMode;
    emit QuadrataWhitelistModeChanged(_whitelistMode);
  }

  function quadrataWhitelist(address provider) public onlyComponentRole(QUADRATA_WHITELIST_ROLE) {
    require(provider != address(0), "Provider cannot be the zero address");
    // TODO: query quadrata
    bool isEligibleCountry = true;
    bool isEligibleAML = true;

    require(
      isEligibleCountry && isEligibleAML,
      "Provider's passport not eligible for whitelisting"
    );

    _whitelistAddress(provider, _whitelistMode);
  }

  function setWhitelistMode(
    WhitelistStatus calldata newMode
  ) public onlyComponentRole(LP_WHITELIST_ADMIN_ROLE) {
    _whitelistMode = newMode;
    emit QuadrataWhitelistModeChanged(_whitelistMode);
  }

  function reader() external view virtual returns (IQuadReader) {
    return _reader;
  }
}
