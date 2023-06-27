// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {SignedQuoteRiskModule} from "@ensuro/core/contracts/SignedQuoteRiskModule.sol";
import {Policy} from "@ensuro/core/contracts/Policy.sol";
import {IPolicyPool} from "@ensuro/core/contracts/interfaces/IPolicyPool.sol";
import {IPolicyHolder} from "@ensuro/core/contracts/interfaces/IPolicyHolder.sol";

/**
 * @title CashFlow Lender Module
 * @dev
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract ERC4626CashFlowLender is
  AccessControlUpgradeable,
  UUPSUpgradeable,
  ERC4626Upgradeable,
  IPolicyHolder
{
  using SafeERC20 for IERC20Metadata;

  bytes32 public constant LP_ROLE = keccak256("LP_ROLE");
  bytes32 public constant CUSTOMER_ROLE = keccak256("CUSTOMER_ROLE");
  bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
  bytes32 public constant POLICY_CREATOR_ROLE = keccak256("POLICY_CREATOR_ROLE");
  bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  SignedQuoteRiskModule internal immutable _riskModule;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IERC20Metadata private immutable _asset;
  int256 internal _debt;

  event DebtChanged(int256 currentDebt);
  event Withdrawal(address indexed destination, uint256 amount);

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(SignedQuoteRiskModule riskModule_, IERC20Metadata asset_) {
    require(
      address(riskModule_) != address(0),
      "ERC4626CashFlowLender: riskModule_ cannot be zero address"
    );
    require(address(asset_) != address(0), "ERC4626CashFlowLender: asset_ cannot be zero address");
    _disableInitializers();
    _riskModule = riskModule_;
    _asset = asset_;
  }

  /**
   * @dev Initializes the ERC4626CashFlowLender
   */
  function initialize() public virtual initializer {
    __ERC4626CashFlowLender_init();
  }

  // solhint-disable-next-line func-name-mixedcase
  function __ERC4626CashFlowLender_init() internal onlyInitializing {
    __UUPSUpgradeable_init();
    __AccessControl_init();
    _setupRole(DEFAULT_ADMIN_ROLE, _msgSender());
    // Infinite approval to the PolicyPool to pay the premiums
    _currency().approve(address(_pool()), type(uint256).max);
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

  /**
   *
   * @param amount Amount of assets to be deposited
   */
  function _increaseDebt(uint256 amount) internal {
    _debt += int256(amount);
    emit DebtChanged(_debt);
  }

  /**
   *
   * @param amount Amount of assets to be withdrawn
   */
  function _decreaseDebt(uint256 amount) internal {
    _debt -= int256(amount);
    emit DebtChanged(_debt);
  }

  /**
   * @dev Returns the current amount the customer owes.
   */
  function currentDebt() external view returns (int256) {
    return _debt;
  }

  function asset() public view virtual override returns (address) {
    return address(_asset);
  }

  function totalAssets() public view virtual override returns (uint256) {
    if (_debt < 0) {
      uint256 balance = _asset.balanceOf(address(this));
      if (balance < uint256(-_debt)) return 0;
    }
    return _asset.balanceOf(address(this)) + uint256(_debt);
  }

  /**
   * @dev Returns the address of the wrapped riskModule
   */
  function riskModule() public view virtual returns (SignedQuoteRiskModule) {
    return _riskModule;
  }

  /**
   * @dev Deposit funds into the contract
   *
   * Requirements:
   * - onlyRole(LP_ROLE)
   *
   * @param assets The amount to deposit.
   * @param receiver The address that will receive the transferred funds.
   * @return Returns the actual amount withdrawn.
   */
  function deposit(
    uint256 assets,
    address receiver
  ) public override onlyRole(LP_ROLE) returns (uint256) {
    _increaseDebt(assets);
    return super.deposit(assets, receiver);
  }

  /**
   * @dev Withdraws funds from the contract
   *
   * Requirements:
   * - onlyRole(CUSTOMER_ROLE)
   *
   * @param assets The amount to withdraw.
   * @param receiver The address that will receive the transferred funds.
   * @return Returns the actual amount withdrawn.
   */
  function withdraw(
    uint256 assets,
    address receiver,
    address // owner is ignored
  ) public override onlyRole(CUSTOMER_ROLE) returns (uint256) {
    require(receiver != address(0), "ERC4626CashFlowLender: receiver cannot be the zero address");
    require(_debt >= 0, "ERC4626CashFlowLender: cannot withdraw if there's debt with the customer");
    uint256 balance = IERC20Metadata(asset()).balanceOf(address(this));
    require(balance >= assets, "ERC4626CashFlowLender: not enough assets to withdraw");
    if (assets > 0) {
      _decreaseDebt(assets);
      _currency().safeTransfer(receiver, assets);
      emit Withdrawal(receiver, assets);
    }
    return assets;
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

  function resolvePolicy(
    Policy.PolicyData calldata policy,
    uint256 payout
  ) external onlyRole(RESOLVER_ROLE) {
    SignedQuoteRiskModule(address(policy.riskModule)).resolvePolicy(policy, payout);
  }

  function resolvePolicyFullPayout(
    Policy.PolicyData calldata policy,
    bool customerWon
  ) external onlyRole(RESOLVER_ROLE) {
    SignedQuoteRiskModule(address(policy.riskModule)).resolvePolicyFullPayout(policy, customerWon);
  }

  function onERC721Received(
    address,
    address,
    uint256,
    bytes calldata
  ) external pure override returns (bytes4) {
    return IERC721Receiver.onERC721Received.selector;
  }

  function onPolicyExpired(address, address, uint256) external pure override returns (bytes4) {
    return IPolicyHolder.onPolicyExpired.selector;
  }

  function onPayoutReceived(
    address,
    address,
    uint256,
    uint256 amount
  ) external override returns (bytes4) {
    require(msg.sender == address(_pool()), "Only the PolicyPool should call this method");
    _decreaseDebt(amount);
    return IPolicyHolder.onPayoutReceived.selector;
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[48] private __gap;
}
