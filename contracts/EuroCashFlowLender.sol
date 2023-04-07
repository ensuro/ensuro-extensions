// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
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
 *      The module is designed to be used with a EUR oracle, but it can be used with any currency
 *
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
  bytes32 public constant CUSTOMER_ROLE = keccak256("CUSTOMER_ROLE");

  uint8 internal constant WAD_DECIMALS = 18;
  uint40 internal constant ORACLE_TOLERANCE = 3600;

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  TrustfulRiskModule internal immutable _riskModule;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  AggregatorV3Interface internal immutable _assetOracle;
  address internal _customer;
  uint256 internal _fxRiskBuffer; // in wad (18 decimals)
  int256 internal _debt; // in Euro

  event DebtChanged(int256 currentDebt);
  event CustomerChanged(address customer);
  event FxRiskBufferChanged(uint256 _newRiskBuffer);
  event Withdrawal(address destination, uint256 amount);
  event CashOutPayout(address destination, uint256 amount, uint256 usdAmount);

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(TrustfulRiskModule riskModule_, AggregatorV3Interface assetOracle_) {
    require(
      address(riskModule_) != address(0),
      "EuroCashFlowLender: riskModule_ cannot be zero address"
    );
    require(
      address(assetOracle_) != address(0),
      "EuroCashFlowLender: assetOracle_ cannot be zero address"
    );
    _disableInitializers();
    _riskModule = riskModule_;
    _assetOracle = assetOracle_;
  }

  /**
   * @dev Initializes the EuroCashFlowLender
   * @param customer_ Address of the customer who will receive the payouts when debt = 0
   */
  function initialize(address customer_, uint256 fxRiskBuffer_) public virtual initializer {
    __EuroCashFlowLender_init(customer_, fxRiskBuffer_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __EuroCashFlowLender_init(
    address customer_,
    uint256 fxRiskBuffer_
  ) internal onlyInitializing {
    __UUPSUpgradeable_init();
    __AccessControl_init();
    __EuroCashFlowLender_init_unchained(customer_, fxRiskBuffer_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __EuroCashFlowLender_init_unchained(
    address customer_,
    uint256 fxRiskBuffer_
  ) internal onlyInitializing {
    _setupRole(DEFAULT_ADMIN_ROLE, _msgSender());
    _customer = customer_;
    _fxRiskBuffer = fxRiskBuffer_;
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
    _debt += int256(amount);
    emit DebtChanged(_debt);
  }

  /**
   *
   * @param amount in Euro
   */
  function _decreaseDebt(uint256 amount) internal {
    _debt -= int256(amount);
    emit DebtChanged(_debt);
  }

  function _transformPolicyParams(
    uint256 payout,
    uint256 premium,
    bytes32 policyData
  ) internal view returns (uint256, uint256, uint96) {
    uint256 eurUsdPrice = getEurUsdPrice();
    payout = payout.wadMul(eurUsdPrice).wadMul(_fxRiskBuffer);
    premium = premium.wadMul(eurUsdPrice);
    uint96 internalId = uint96(uint256(policyData) % 2 ** 96);
    return (payout, premium, internalId);
  }

  function getEurUsdPrice() public view returns (uint256) {
    (, int256 price, , uint256 updatedAt, ) = _assetOracle.latestRoundData();
    require(updatedAt > block.timestamp - ORACLE_TOLERANCE, "Price is older than tolerable");
    return _scalePrice(SafeCast.toUint256(price), _assetOracle.decimals(), WAD_DECIMALS);
  }

  function _scalePrice(
    uint256 price,
    uint8 priceDecimals,
    uint8 decimals
  ) internal pure returns (uint256) {
    if (priceDecimals < decimals) return price * 10 ** (decimals - priceDecimals);
    else return price / 10 ** (priceDecimals - decimals);
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
        address(riskModule()),
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

    (uint256 usdPayout, uint256 usdPremium, uint96 internalId) = _transformPolicyParams(
      payout,
      premium,
      policyData
    );
    _increaseDebt(premium);
    createdPolicy = riskModule().newPolicyFull(
      usdPayout,
      usdPremium,
      lossProb,
      expiration,
      address(this),
      internalId
    );
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
    (uint256 usdPayout, uint256 usdPremium, uint96 internalId) = _transformPolicyParams(
      payout,
      premium,
      policyData
    );

    _increaseDebt(premium);
    policyId = riskModule().newPolicy(
      usdPayout,
      usdPremium,
      lossProb,
      expiration,
      address(this),
      internalId
    );
    return policyId;
  }

  function _resolvePolicy(Policy.PolicyData calldata policy, uint256 payout) internal {
    payout = payout.wadMul(getEurUsdPrice());
    TrustfulRiskModule(address(policy.riskModule)).resolvePolicy(policy, payout);
  }

  function resolvePolicy(
    Policy.PolicyData calldata policy,
    uint256 payout
  ) external onlyRole(RESOLVER_ROLE) {
    _resolvePolicy(policy, payout);
  }

  function resolvePolicyFullPayout(
    Policy.PolicyData calldata policy,
    bool customerWon
  ) external onlyRole(RESOLVER_ROLE) {
    _resolvePolicy(policy, customerWon ? policy.payout : 0);
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
    uint256 payoutEUR = amount.wadDiv(getEurUsdPrice());
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
    require(_debt > 0, "EuroCashFlowLender: cannot withdraw when there is no debt");
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

  function fxRiskBuffer() external view virtual returns (uint256) {
    return _fxRiskBuffer;
  }

  function setBuffer(uint256 buffer_) external onlyRole(OWNER_ROLE) {
    _fxRiskBuffer = buffer_;
    emit FxRiskBufferChanged(_fxRiskBuffer);
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
    uint256 usdAmount = amount.wadMul(getEurUsdPrice());
    _currency().safeTransferFrom(_msgSender(), address(this), usdAmount);
  }

  /**
   *
   * @param amount The amount (in  Euro) to pay
   */
  function cashOutPayouts(uint256 amount, address destination) external onlyRole(CUSTOMER_ROLE) {
    require(
      _debt < 0 && int256(amount) <= -_debt,
      "EuroCashFlowLender: amount must be less than debt"
    );
    uint256 usdAmount = amount.wadMul(getEurUsdPrice());
    require(_balance() >= usdAmount, "Not enough balance to pay the debt");
    _increaseDebt(amount); // Sería increase, porque la deuda es negativa y pasa a ser menos negativa.
    _currency().transfer(destination, usdAmount);
    emit CashOutPayout(destination, amount, usdAmount);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[48] private __gap;
}
