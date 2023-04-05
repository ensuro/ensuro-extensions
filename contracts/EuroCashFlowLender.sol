// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import {TrustfulRiskModule} from "@ensuro/core/contracts/TrustfulRiskModule.sol";
import {Policy} from "@ensuro/core/contracts/Policy.sol";
import {IPolicyPool} from "@ensuro/core/contracts/interfaces/IPolicyPool.sol";
import {IPolicyHolder} from "@ensuro/core/contracts/interfaces/IPolicyHolder.sol";
import {WadRayMath} from "@ensuro/core/contracts/dependencies/WadRayMath.sol";

/**
 * @title CashFlow Lender Module
 * @dev This module acts as a proxy for a TrustfulRiskModule, paying the premium and retaining the ownership of the
 *      policies as collateral. When there's a payout, the funds are retained to pay the debt and the remaining is
 *      transferred to the customer address.
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract EuroCashFlowLender is AccessControlUpgradeable, UUPSUpgradeable, IPolicyHolder {
  using WadRayMath for uint256;
  using SafeERC20 for IERC20Metadata;

  bytes32 public constant POLICY_CREATOR_ROLE = keccak256("POLICY_CREATOR_ROLE");
  bytes32 public constant PRICER_ROLE = keccak256("PRICER_ROLE");
  bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");
  bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");
  bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  TrustfulRiskModule internal immutable _riskModule;
  address internal _customer;
  uint256 internal _buffer;
  int256 internal _debt;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  AggregatorV3Interface internal immutable _assetOracle;

  event DebtChanged(int256 currentDebt);
  event CustomerChanged(address customer);
  event Withdrawal(address destination, uint256 amount);

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(TrustfulRiskModule riskModule_, AggregatorV3Interface assetOracle_) {
    require(
      address(riskModule_) != address(0),
      "EuroCashFlowLender: riskModule_ cannot be zero address"
    );
    require(
      address(assetOracle_) != address(0),
      "EuroCashFlowLender: assetOracle_ cannot be the zero address"
    );
    _disableInitializers();
    _riskModule = riskModule_;
    _assetOracle = assetOracle_;
  }

  /**
   * @dev Initializes the EuroCashFlowLender
   * @param customer_ Address of the customer who will receive the payouts when debt = 0
   */
  function initialize(address customer_, uint256 buffer_) public initializer {
    __EuroCashFlowLender_init(customer_, buffer_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __EuroCashFlowLender_init(address customer_, uint256 buffer_) internal onlyInitializing {
    __UUPSUpgradeable_init();
    __AccessControl_init();
    _setupRole(DEFAULT_ADMIN_ROLE, _msgSender());
    _customer = customer_;
    _buffer = buffer_;
    emit CustomerChanged(customer_);
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
   * @param amount in Euro
   */
  function _increaseDebt(uint256 amount) internal {
    _debt += amount >= 0 ? int256(amount) : -int256(amount);
    emit DebtChanged(_debt);
  }

  /**
   *
   * @param amount in Euro
   */
  function _decreaseDebt(uint256 amount) internal {
    _debt -= amount >= 0 ? int256(amount) : -int256(amount);
    emit DebtChanged(_debt);
  }

  function _getEurUsdPrice() internal view returns (uint256) {
    (, int256 price, , , ) = _assetOracle.latestRoundData();
    return uint256(price);
  }

  function _validatePolicyQuote(
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    bytes32 policyData,
    uint40 quoteValidUntil,
    bytes32 quoteSignatureR,
    bytes32 quoteSignatureVS
  ) internal view {
    /**
     * Checks the quote has been signed by an authorized user
     * The "quote" is computed as hash of the following fields (encodePacked):
     * - address: the address of the RiskModule
     * - payout, premium, lossProb, expiration: the base parameters of the policy
     * - policyData: a hash of the private details of the policy. The calculation should include some
     *   unique id (quoteId), so each policyData identifies a policy.
     * - quoteValidUntil: the maximum validity of the quote
     */
    bytes32 quoteHash = ECDSA.toEthSignedMessageHash(
      abi.encodePacked(
        address(_riskModule),
        payout,
        premium,
        lossProb,
        expiration,
        policyData,
        quoteValidUntil
      )
    );
    address signer = ECDSA.recover(quoteHash, quoteSignatureR, quoteSignatureVS);
    _checkRole(PRICER_ROLE, signer);
  }

  /**
   * @dev Creates a new policy paid by this contract and increases the debt. See {TrustfulRiskModule.newPolicyFull}
   *
   * Requirements:
   * - Caller must have POLICY_CREATOR_ROLE
   *
   * @param payout The exposure (maximum payout) of the policy (in Euro)
   * @param premium The premium that will be paid by the payer (in Euro)
   * @param lossProb The probability of having to pay the maximum payout (wad)
   * @param expiration The expiration of the policy (timestamp)
   * @param policyData A hash of the private details of the policy. The last 96 bits will be used as internalId
   * @param quoteSignatureR The signature of the quote. R component (EIP-2098 signature)
   * @param quoteSignatureVS The signature of the quote. VS component (EIP-2098 signature)
   * @param quoteValidUntil The expiration of the quote
   * @return createdPolicy Returns the created policy
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
    _validatePolicyQuote(
      payout,
      premium,
      lossProb,
      expiration,
      policyData,
      quoteValidUntil,
      quoteSignatureR,
      quoteSignatureVS
    );

    // Convierto el payout y premium a USD para mandarlo al RM
    uint256 eurUsdPrice = _getEurUsdPrice();
    payout = payout.wadMul(eurUsdPrice).wadMul(_buffer);
    uint256 usdPremium = premium.wadMul(eurUsdPrice);

    uint96 internalId = uint96(uint256(policyData) % 2 ** 96);
    createdPolicy = riskModule().newPolicyFull(
      payout,
      usdPremium,
      lossProb,
      expiration,
      address(this),
      internalId
    );
    _increaseDebt(premium);
    return createdPolicy;
  }

  /**
   * @dev Creates a new policy paid by this contract and increases the debt. See {TrustfulRiskModule.newPolicy}
   *
   * Requirements:
   * - Caller must have POLICY_CREATOR_ROLE
   * - _balance() >= than the amount of the premium
   *
   * @param payout The exposure (maximum payout) of the policy (in Euro)
   * @param premium The premium that will be paid by the payer (in Euro)
   * @param lossProb The probability of having to pay the maximum payout (wad)
   * @param expiration The expiration of the policy (timestamp)
   * @param policyData A hash of the private details of the policy. The last 96 bits will be used as internalId
   * @param quoteSignatureR The signature of the quote. R component (EIP-2098 signature)
   * @param quoteSignatureVS The signature of the quote. VS component (EIP-2098 signature)
   * @param quoteValidUntil The expiration of the quote
   * @return policyId Returns the created policy id
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
    _validatePolicyQuote(
      payout,
      premium,
      lossProb,
      expiration,
      policyData,
      quoteValidUntil,
      quoteSignatureR,
      quoteSignatureVS
    );
    // Convierto el payout y premium a USD
    uint256 eurUsdPrice = _getEurUsdPrice();
    payout = payout.wadMul(eurUsdPrice).wadMul(_buffer);
    uint256 usdPremium = premium.wadMul(eurUsdPrice);

    uint96 internalId = uint96(uint256(policyData) % 2 ** 96);
    policyId = riskModule().newPolicy(
      payout,
      usdPremium,
      lossProb,
      expiration,
      address(this),
      internalId
    );
    _increaseDebt(premium);
    return policyId;
  }

  function resolvePolicy(
    Policy.PolicyData calldata policy,
    uint256 payout
  ) external onlyRole(RESOLVER_ROLE) {
    uint256 eurUsdPrice = _getEurUsdPrice();
    payout = payout * eurUsdPrice;
    TrustfulRiskModule(address(policy.riskModule)).resolvePolicy(policy, payout);
  }

  function resolvePolicyFullPayout(
    Policy.PolicyData calldata policy,
    bool customerWon
  ) external onlyRole(RESOLVER_ROLE) {
    TrustfulRiskModule(address(policy.riskModule)).resolvePolicyFullPayout(policy, customerWon);
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

  /**
   * @dev Whenever an Policy is resolved with payout > 0, this function is called
   *
   * It must return its Solidity selector to confirm the payout.
   * If interface is not implemented by the recipient, it will be ignored and the payout will be successful.
   * If any other value is returned or it reverts, the policy resolution / payout will be reverted.
   *
   * The selector can be obtained in Solidity with `IPolicyPool.onPayoutReceived.selector`.
   *
   */
  function onPayoutReceived(
    address,
    address,
    uint256,
    uint256 amount
  ) external override returns (bytes4) {
    require(msg.sender == address(_pool()), "Only the PolicyPool should call this method");
    uint256 eurUsdPrice = _getEurUsdPrice();
    uint256 payoutEUR = amount / eurUsdPrice;
    _decreaseDebt(payoutEUR);
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
  function withdraw(
    uint256 amount,
    address destination
  ) external onlyRole(OWNER_ROLE) returns (uint256) {
    require(
      destination != address(0),
      "EuroCashFlowLender: destination cannot be the zero address"
    );
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
  function currentDebt() external view returns (int256) {
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
  function riskModule() public view virtual returns (TrustfulRiskModule) {
    return _riskModule;
  }

  /**
   * @dev Returns the address of the oracle used to convert the asset to USD
   */
  function assetOracle() external view returns (AggregatorV3Interface) {
    return _assetOracle;
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
   * @param amount The amount (in  Euro) to pay
   */
  function repayDebt(uint256 amount) external {
    require(_debt > 0, "EuroCashFlowLender: debt must be greater than 0");
    require(int256(amount) <= _debt, "EuroCashFlowLender: amount must be less than debt");
    _decreaseDebt(amount);
    // Convierto el amount a USD y se lo mando a safeTransferFrom
    uint256 eurUsdPrice = _getEurUsdPrice();
    uint256 usdAmount = amount * eurUsdPrice;

    _currency().safeTransferFrom(_msgSender(), address(this), usdAmount);
  }

  /**
   *
   * @param amount The amount (in  Euro) to pay
   */
  function cashOutPayouts(uint256 amount) external {
    require(
      _debt < 0 && int256(amount) <= -_debt,
      "EuroCashFlowLender: amount must be less than debt"
    );
    require(int256(amount) <= _debt, "EuroCashFlowLender: amount must be less than debt");

    _decreaseDebt(amount);
    // Convierto el amount a USD
    uint256 eurUsdPrice = _getEurUsdPrice();
    uint256 usdAmount = amount * eurUsdPrice;

    _currency().safeTransferFrom(_msgSender(), address(this), usdAmount);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[48] private __gap;
}
