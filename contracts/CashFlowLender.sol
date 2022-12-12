// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import {SignedQuoteRiskModule} from "@ensuro/core/contracts/SignedQuoteRiskModule.sol";
import {Policy} from "@ensuro/core/contracts/Policy.sol";

/**
 * @title CashFlow Lender Module
 * @dev This module acts as a proxy for a SignedQuoteRiskModule, paying the premium and retaining the ownership of the
 *      policies as collateral. When there's a payout, the funds are retained to pay the debt and the remaining is
 *      transferred to the customer address.
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract CashFlowLender is AccessControlUpgradeable, UUPSUpgradeable {
  using SafeERC20 for IERC20Metadata;

  bytes32 public constant POLICY_CREATOR_ROLE = keccak256("POLICY_CREATOR_ROLE");
  bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");
  bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");
  bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

  SignedQuoteRiskModule internal immutable _riskModule;
  address internal _customer;
  uint256 internal _debt;

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(SignedQuoteRiskModule riskModule_) {
    require(
      address(riskModule_) != address(0),
      "CashFlowLender: riskModule_ cannot be zero address"
    );
    _disableInitializers();
    _riskModule = riskModule_;
  }

  /**
   * @dev Initializes the CashFlowLender
   * @param customer_ Address of the customer who will receive the payouts when debt = 0
   */
  function initialize(address customer_) public initializer {
    __CashFlowLender_init(customer_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __CashFlowLender_init(address customer_) internal onlyInitializing {
    __UUPSUpgradeable_init();
    __AccessControl_init();
    _setupRole(DEFAULT_ADMIN_ROLE, _msgSender());
    _customer = customer_;
    // Infinite approval to the PolicyPool to pay the premiums
    _riskModule.currency().approve(address(_riskModule.policyPool()), type(uint256).max);
  }

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address newImpl) internal view override onlyRole(GUARDIAN_ROLE) {}

  function _balance() internal view returns (uint256) {
    return _riskModule.currency().balanceOf(address(this));
  }

  /**
   * @dev Creates a new policy paid by this contract and increases the debt. See {SignedQuoteRiskModule.newPolicyFull}
   *
   * Requirements:
   * - Caller must have POLICY_CREATOR_ROLE
   * - _balance() >= than the amount of the premium
   *
   */
  function newPolicyFull(
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    address, // onBehalfOf is ignored
    bytes32 policyData,
    bytes32 quoteSignatureR,
    bytes32 quoteSignatureVS,
    uint40 quoteValidUntil
  ) external onlyRole(POLICY_CREATOR_ROLE) returns (Policy.PolicyData memory createdPolicy) {
    uint256 balanceBefore = _balance();
    createdPolicy = _riskModule.newPolicyFull(
      payout,
      premium,
      lossProb,
      expiration,
      address(this),
      policyData,
      quoteSignatureR,
      quoteSignatureVS,
      quoteValidUntil
    );
    // Increases the debt
    _debt += balanceBefore - _balance();
    return createdPolicy;
  }

  /**
   * @dev Creates a new policy paid by this contract and increases the debt. See {SignedQuoteRiskModule.newPolicy}
   *
   * Requirements:
   * - Caller must have POLICY_CREATOR_ROLE
   * - _balance() >= than the amount of the premium
   *
   */
  function newPolicy(
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    address, // onBehalfOf is ignored
    bytes32 policyData,
    bytes32 quoteSignatureR,
    bytes32 quoteSignatureVS,
    uint40 quoteValidUntil
  ) external onlyRole(POLICY_CREATOR_ROLE) returns (uint256 policyId) {
    uint256 balanceBefore = _balance();
    policyId = _riskModule.newPolicy(
      payout,
      premium,
      lossProb,
      expiration,
      address(this),
      policyData,
      quoteSignatureR,
      quoteSignatureVS,
      quoteValidUntil
    );
    // Increases the debt
    _debt += balanceBefore - _balance();
    return policyId;
  }

  /**
   * @dev Creates a new policy paid by this contract and increases the debt. See
   * {SignedQuoteRiskModule.newPolicyPaidByHolder}
   *
   * Requirements:
   * - Caller must have POLICY_CREATOR_ROLE
   * - _balance() >= than the amount of the premium
   *
   */
  function newPolicyPaidByHolder(
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    address, // onBehalfOf is ignored
    bytes32 policyData,
    bytes32 quoteSignatureR,
    bytes32 quoteSignatureVS,
    uint40 quoteValidUntil
  ) external returns (uint256 policyId) {
    uint256 balanceBefore = _balance();
    /**
     * Calls newPolicy instead of newPolicyPaidByHolder because customer == msg.sender. We just keep this method
     * to work as a no-code change replacement of the SignedQuoteRiskModule
     */
    policyId = _riskModule.newPolicy(
      payout,
      premium,
      lossProb,
      expiration,
      address(this),
      policyData,
      quoteSignatureR,
      quoteSignatureVS,
      quoteValidUntil
    );
    // Increases the debt
    _debt += balanceBefore - _balance();
    return policyId;
  }

  function _repayDebtTransferRest(uint256 balanceBefore) internal {
    uint256 payout = _balance() - balanceBefore;
    if (payout <= _debt) {
      _debt -= payout;
    } else {
      if (_debt != 0) {
        payout -= _debt;
        _debt = 0;
      }
      _riskModule.currency().safeTransfer(_customer, payout);
    }
  }

  function resolvePolicy(
    Policy.PolicyData calldata policy,
    uint256 payout
  ) external onlyRole(RESOLVER_ROLE) {
    uint256 balanceBefore = _balance();
    _riskModule.resolvePolicy(policy, payout);
    _repayDebtTransferRest(balanceBefore);
  }

  function resolvePolicyFullPayout(
    Policy.PolicyData calldata policy,
    bool customerWon
  ) external onlyRole(RESOLVER_ROLE) {
    uint256 balanceBefore = _balance();
    _riskModule.resolvePolicyFullPayout(policy, customerWon);
    _repayDebtTransferRest(balanceBefore);
  }

  /**
   *
   * Withdraws funds from the contract
   *
   * Can be executed by the owner to recover the funds.
   *
   * Requirements:
   * - onlyRole(OWNER_ROLE)
   *
   * @param amount The amount to withdraw. If amount == type(uint256).max means all the funds
   * @param destination The address that will receive the transferred funds.
   * @return Returns the actual amount withdrawn.
   */
  function withdraw(
    uint256 amount,
    address destination
  ) external onlyRole(OWNER_ROLE) returns (uint256) {
    require(destination != address(0), "CashFlowLender: destination cannot be the zero address");
    if (amount == type(uint256).max) {
      amount = _balance();
    } else {
      // If _balance() < amount, withdraws _balance()
      amount = Math.min(amount, _balance());
    }
    if (amount > 0) {
      _riskModule.currency().safeTransfer(destination, amount);
    }
    return amount;
  }

  function currentDebt() external view returns (uint256) {
    return _debt;
  }

  /**
   *
   * Repays the debt
   *
   * @param amount The amount to pay
   */
  function repayDebt(uint256 amount) external {
    amount = Math.min(_debt, amount);
    _debt -= amount;
    _riskModule.currency().safeTransferFrom(_msgSender(), address(this), amount);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[48] private __gap;
}
