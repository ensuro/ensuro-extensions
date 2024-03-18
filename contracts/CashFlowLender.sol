// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {SignedQuoteRiskModule} from "@ensuro/core/contracts/SignedQuoteRiskModule.sol";
import {Policy} from "@ensuro/core/contracts/Policy.sol";
import {IPolicyPool} from "@ensuro/core/contracts/interfaces/IPolicyPool.sol";
import {IPolicyHolder} from "@ensuro/core/contracts/interfaces/IPolicyHolder.sol";

/**
 * @title CashFlow Lender Module
 * @dev This module acts as a proxy for a SignedQuoteRiskModule, paying the premium and retaining the ownership of the
 *      policies as collateral. When there's a payout, the funds are retained to pay the debt and the remaining is
 *      transferred to the customer address.
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract CashFlowLender is AccessControlUpgradeable, UUPSUpgradeable, IPolicyHolder {
  using SafeERC20 for IERC20Metadata;

  bytes32 public constant POLICY_CREATOR_ROLE = keccak256("POLICY_CREATOR_ROLE");
  bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");
  bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");
  bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  SignedQuoteRiskModule internal immutable _riskModule;
  address internal _customer;
  uint256 internal _debt;

  event DebtChanged(uint256 currentDebt);
  event CustomerChanged(address customer);
  event Withdrawal(address destination, uint256 amount);

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(SignedQuoteRiskModule riskModule_) {
    require(address(riskModule_) != address(0), "CashFlowLender: riskModule_ cannot be zero address");
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
    emit CustomerChanged(customer_);
    // Infinite approval to the PolicyPool to pay the premiums
    _currency().approve(address(_pool()), type(uint256).max);
  }

  /**
   * @dev See {IERC165-supportsInterface}.
   */
  function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
    return interfaceId == type(IPolicyHolder).interfaceId || super.supportsInterface(interfaceId);
  }

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address newImpl) internal view override onlyRole(GUARDIAN_ROLE) {}

  function _pool() internal view returns (IPolicyPool) {
    return _riskModule.policyPool();
  }

  function _currency() internal view returns (IERC20Metadata) {
    return _pool().currency();
  }

  function _balance() internal view returns (uint256) {
    return _currency().balanceOf(address(this));
  }

  function _increaseDebt(uint256 amount) internal {
    _debt += amount;
    emit DebtChanged(_debt);
  }

  function _decreaseDebt(uint256 amount) internal {
    _debt -= amount;
    emit DebtChanged(_debt);
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
    createdPolicy = riskModule().newPolicyFull(
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
    _increaseDebt(balanceBefore - _balance());
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
    policyId = riskModule().newPolicy(
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
    _increaseDebt(balanceBefore - _balance());
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
  ) external onlyRole(POLICY_CREATOR_ROLE) returns (uint256 policyId) {
    uint256 balanceBefore = _balance();
    /**
     * Calls newPolicy instead of newPolicyPaidByHolder because customer == msg.sender. We just keep this method
     * to work as a no-code change replacement of the SignedQuoteRiskModule
     */
    policyId = riskModule().newPolicy(
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
    _increaseDebt(balanceBefore - _balance());
    return policyId;
  }

  /**
   * @dev Creates several policies paid by this contract and increases the debt. See {SignedQuoteRiskModule.newPolicy}
   *
   * Requirements:
   * - Caller must have POLICY_CREATOR_ROLE
   * - _balance() >= than the amount of the premium
   *
   */
  function newPoliciesInBatch(
    uint256[] memory payout,
    uint256[] memory premium,
    uint256[] memory lossProb,
    uint40[] memory expiration,
    bytes32[] memory policyData,
    bytes32[] memory quoteSignatureR,
    bytes32[] memory quoteSignatureVS,
    uint40[] memory quoteValidUntil
  ) external onlyRole(POLICY_CREATOR_ROLE) {
    uint256 balanceBefore = _balance();
    SignedQuoteRiskModule rm = riskModule();

    for (uint256 i = 0; i < payout.length; i++) {
      rm.newPolicy(
        payout[i],
        premium[i],
        lossProb[i],
        expiration[i],
        address(this),
        policyData[i],
        quoteSignatureR[i],
        quoteSignatureVS[i],
        quoteValidUntil[i]
      );
    }
    // Increases the debt
    _increaseDebt(balanceBefore - _balance());
  }

  function _repayDebtTransferRest(uint256 payout) internal {
    if (payout <= _debt) {
      _decreaseDebt(payout);
    } else {
      if (_debt != 0) {
        payout -= _debt;
        _decreaseDebt(_debt);
      }
      _currency().safeTransfer(_customer, payout);
    }
  }

  function resolvePolicy(Policy.PolicyData calldata policy, uint256 payout) external onlyRole(RESOLVER_ROLE) {
    SignedQuoteRiskModule(address(policy.riskModule)).resolvePolicy(policy, payout);
  }

  function resolvePolicyFullPayout(
    Policy.PolicyData calldata policy,
    bool customerWon
  ) external onlyRole(RESOLVER_ROLE) {
    SignedQuoteRiskModule(address(policy.riskModule)).resolvePolicyFullPayout(policy, customerWon);
  }

  function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
    return IERC721Receiver.onERC721Received.selector;
  }

  function onPolicyExpired(address, address, uint256) external pure override returns (bytes4) {
    return IPolicyHolder.onPolicyExpired.selector;
  }

  /**
   * @dev Whenever an Policy is resolved with payout > 0, this function is called
   *
   * It must return its Solidity selector to confirm the payout.
   * If interface is not implemented by the recipient, it will be ignored and the payout will be successful.
   * If any other value is returned or it reverts, the policy resolution / payout will be reverted.
   *
   * The selector can be obtained in Solidity with `IPolicyPool.onPayoutReceived.selector`.
   */
  function onPayoutReceived(address, address, uint256, uint256 amount) external override returns (bytes4) {
    require(msg.sender == address(_pool()), "Only the PolicyPool should call this method");
    _repayDebtTransferRest(amount);
    return IPolicyHolder.onPayoutReceived.selector;
  }

  /**
   * @dev Withdraws funds from the contract
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
  function withdraw(uint256 amount, address destination) external onlyRole(OWNER_ROLE) returns (uint256) {
    require(destination != address(0), "CashFlowLender: destination cannot be the zero address");
    if (amount == type(uint256).max) {
      amount = _balance();
    } else {
      // If _balance() < amount, withdraws _balance()
      amount = Math.min(amount, _balance());
    }
    if (amount > 0) {
      _currency().safeTransfer(destination, amount);
      emit Withdrawal(destination, amount);
    }
    return amount;
  }

  /**
   * @dev Returns the current amount the customer owes.
   */
  function currentDebt() external view returns (uint256) {
    return _debt;
  }

  /**
   * @dev Returns the address of the `customer`, the one that will receive the payouts when debt was repaid
   */
  function customer() external view returns (address) {
    return _customer;
  }

  /**
   * @dev Returns the address of the wrapped riskModule
   */
  function riskModule() public view virtual returns (SignedQuoteRiskModule) {
    return _riskModule;
  }

  /**
   * @dev Sets the address of the `customer`, the one that will receive the payouts when debt was repaid
   *
   * Requirements:
   * - Caller has OWNER_ROLE
   *
   * Emits:
   * - CustomerChanged
   *
   * @param customer_ The new address of the customer
   */
  function setCustomer(address customer_) external onlyRole(OWNER_ROLE) {
    _customer = customer_;
    emit CustomerChanged(customer_);
  }

  /**
   *
   * Repays the debt
   *
   * @param amount The amount to pay
   */
  function repayDebt(uint256 amount) external {
    amount = Math.min(_debt, amount);
    _decreaseDebt(amount);
    _currency().safeTransferFrom(_msgSender(), address(this), amount);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[48] private __gap;
}
