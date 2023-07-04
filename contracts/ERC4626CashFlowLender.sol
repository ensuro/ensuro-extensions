// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {SignedQuoteRiskModule} from "@ensuro/core/contracts/SignedQuoteRiskModule.sol";
import {Policy} from "@ensuro/core/contracts/Policy.sol";
import {IPolicyPool} from "@ensuro/core/contracts/interfaces/IPolicyPool.sol";
import {IPolicyHolder} from "@ensuro/core/contracts/interfaces/IPolicyHolder.sol";

/**
 * @title CashFlow Lender Module that tracks ownership
 * @dev Implements the ERC-4626 standard tracking how much liquidity was provided by each LP.
 *      The assets managed by the vault are a mix of liquid USDC + the _debt tracked by the CFL. The _debt can be
 *      negative, in that case, the CFL owes to the customer.
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
  bytes32 public constant CHANGE_RM_ROLE = keccak256("CHANGE_RM_ROLE");
  bytes32 public constant CUSTOMER_ROLE = keccak256("CUSTOMER_ROLE");
  bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
  bytes32 public constant POLICY_CREATOR_ROLE = keccak256("POLICY_CREATOR_ROLE");
  bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");

  SignedQuoteRiskModule internal _riskModule;
  int256 internal _debt;

  event DebtChanged(int256 currentDebt);
  event RiskModuleChanged(SignedQuoteRiskModule newRiskModule);
  event CashOutPayout(address indexed destination, uint256 amount);

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  /**
   * @dev Initializes the ERC4626CashFlowLender
   */
  function initialize(
    SignedQuoteRiskModule riskModule_,
    IERC20Upgradeable asset_
  ) public virtual initializer {
    __ERC4626CashFlowLender_init(riskModule_, asset_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __ERC4626CashFlowLender_init(
    SignedQuoteRiskModule riskModule_,
    IERC20Upgradeable asset_
  ) internal onlyInitializing {
    __UUPSUpgradeable_init();
    __AccessControl_init();
    require(address(asset_) != address(0), "ERC4626CashFlowLender: asset_ cannot be zero address");
    __ERC4626_init(asset_);
    __ERC4626CashFlowLender_init_unchained(riskModule_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __ERC4626CashFlowLender_init_unchained(
    SignedQuoteRiskModule riskModule_
  ) internal onlyInitializing {
    require(
      address(riskModule_) != address(0),
      "ERC4626CashFlowLender: riskModule_ cannot be zero address"
    );
    _setupRole(DEFAULT_ADMIN_ROLE, _msgSender());

    _riskModule = riskModule_;
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

  function totalAssets() public view virtual override returns (uint256) {
    uint256 balance = _balance();
    if (_debt < 0) {
      return balance - uint256(-_debt);
    }
    return balance + uint256(_debt);
  }

  /**
   * @dev Returns the address of the wrapped riskModule
   */
  function riskModule() public view virtual returns (SignedQuoteRiskModule) {
    return _riskModule;
  }

  function setRiskModule(SignedQuoteRiskModule riskModule_) external onlyRole(CHANGE_RM_ROLE) {
    require(
      address(riskModule_) != address(0),
      "ERC4626CashFlowLender: riskModule_ cannot be zero address"
    );
    require(
      riskModule_.policyPool() == _pool(),
      "ERC4626CashFlowLender: new riskModule must belong to the same pool"
    );
    _riskModule = riskModule_;
    emit RiskModuleChanged(_riskModule);
  }

  /**
   * @dev See {IERC4626-deposit}.
   */
  function deposit(
    uint256 assets,
    address receiver
  ) public virtual override onlyRole(LP_ROLE) returns (uint256) {
    return super.deposit(assets, receiver);
  }

  /**
   * @dev See {IERC4626-mint}.
   */
  function mint(
    uint256 shares,
    address receiver
  ) public virtual override onlyRole(LP_ROLE) returns (uint256) {
    return super.mint(shares, receiver);
  }

  /**
   * @dev See {IERC4626-withdraw}.
   */
  function withdraw(
    uint256 assets,
    address receiver,
    address owner
  ) public virtual override onlyRole(LP_ROLE) returns (uint256) {
    return super.withdraw(assets, receiver, owner);
  }

  /**
   * @dev See {IERC4626-redeem}.
   */
  function redeem(
    uint256 assets,
    address receiver,
    address owner
  ) public virtual override onlyRole(LP_ROLE) returns (uint256) {
    return super.redeem(assets, receiver, owner);
  }

  function _withdraw(
    address caller,
    address receiver,
    address owner,
    uint256 assets,
    uint256 shares
  ) internal virtual override {
    require(_balance() >= assets, "ERC4626CashFlowLender: Not enough balance to withdraw");
    super._withdraw(caller, receiver, owner, assets, shares);
  }

  /**
   *
   * @param amount The amount to pay
   */
  function cashOutPayouts(uint256 amount, address destination) external onlyRole(CUSTOMER_ROLE) {
    require(
      _debt < 0 && int256(amount) <= -_debt,
      "ERC4626CashFlowLender: amount must be less than debt"
    );
    require(_balance() >= amount, "ERC4626CashFlowLender: Not enough balance to pay the debt");
    _increaseDebt(amount);
    _currency().transfer(destination, amount);
    emit CashOutPayout(destination, amount);
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

  /**
   * @dev Resolves several policies paid by this contract and decreases the debt. See {SignedQuoteRiskModule.resolvePolicy}
   *
   * Requirements:
   * - Caller must have RESOLVER_ROLE
   *
   */
  function resolvePoliciesInBatch(
    Policy.PolicyData[] calldata policy,
    uint256[] memory payout
  ) external onlyRole(RESOLVER_ROLE) {
    for (uint256 i = 0; i < payout.length; i++) {
      SignedQuoteRiskModule(address(policy[i].riskModule)).resolvePolicy(policy[i], payout[i]);
    }
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
