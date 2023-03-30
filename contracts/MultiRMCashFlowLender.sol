// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;
import {CashFlowLender} from "./CashFlowLender.sol";
import {SignedQuoteRiskModule} from "@ensuro/core/contracts/SignedQuoteRiskModule.sol";

/**
 * @title Multi RiskModule CashFlow Lender Module
 * @dev Variant of the CashFlowLender that allows to change the target risk module.
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract MultiRMCashFlowLender is CashFlowLender {
  bytes32 public constant ACTIVE_RM_ADMIN_ROLE = keccak256("ACTIVE_RM_ADMIN_ROLE");

  SignedQuoteRiskModule internal _activeRiskModule;

  event ActiveRiskModuleChanged(SignedQuoteRiskModule newActiveRM);

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(SignedQuoteRiskModule riskModule_) CashFlowLender(riskModule_) {}

  /**
   * @dev Returns the address of the riskModule that will be used to create policies
   */
  function riskModule() public view override returns (SignedQuoteRiskModule) {
    return (address(_activeRiskModule) != address(0)) ? _activeRiskModule : _riskModule;
  }

  /**
   * @dev Sets the address of the active riskModule, the one that will receive the new policies. If address(0) is
   *      received, then the _riskModule indicated in contract constructor will be used.
   *
   * Requirements:
   * - Caller has ACTIVE_RM_ADMIN_ROLE
   *
   * Emits:
   * - ActiveRiskModuleChanged
   *
   * @param riskModule_ The new address of the new riskModule
   */
  function setActiveRiskModule(
    SignedQuoteRiskModule riskModule_
  ) external onlyRole(ACTIVE_RM_ADMIN_ROLE) {
    require(
      address(riskModule_) == address(0) || riskModule_.policyPool() == _riskModule.policyPool(),
      "The new risk module has to be part of the same pool"
    );
    _activeRiskModule = riskModule_;
    emit ActiveRiskModuleChanged(address(riskModule_) == address(0) ? _riskModule : riskModule_);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[49] private __gap;
}
