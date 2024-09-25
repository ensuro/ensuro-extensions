// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {IPolicyPool} from "@ensuro/core/contracts/interfaces/IPolicyPool.sol";
import {IPolicyHolder} from "@ensuro/core/contracts/interfaces/IPolicyHolder.sol";
import {SwapLibrary} from "@ensuro/swaplibrary/contracts/SwapLibrary.sol";

import {ERC4626CashFlowLender} from "./ERC4626CashFlowLender.sol";

/**
 * @title StableSwapPayoutHandler
 * @author Ensuro Dev Team (dev@ensuro.co)
 * @custom:security-contact security@ensuro.co
 * @notice NFT that wraps an Ensuro Policy NFT and handles the swap of the payout to a different stablecoin.
 */
contract StableSwapPayoutHandler is
  Initializable,
  AccessControlUpgradeable,
  ERC721Upgradeable,
  PausableUpgradeable,
  UUPSUpgradeable,
  IPolicyHolder
{
  using SafeERC20 for IERC20Metadata;
  using SwapLibrary for SwapLibrary.SwapConfig;

  bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
  bytes32 public constant POLICY_CREATOR_ROLE = keccak256("POLICY_CREATOR_ROLE");
  bytes32 public constant SWAP_PRICER_ROLE = keccak256("SWAP_PRICER_ROLE");

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IERC20Metadata internal immutable _outStable;

  IPolicyPool internal _pool;
  ERC4626CashFlowLender internal _cashflowLender;
  SwapLibrary.SwapConfig internal _swapConfig;
  uint256 internal _swapPrice;

  event SwapConfigChanged(SwapLibrary.SwapConfig newConfig);
  event SwapPriceChanged(uint256 newPrice);

  /**
   * @param outSable_ The address of the stablecoin to be used for payouts
   */
  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(IERC20Metadata outSable_) {
    require(address(outSable_) != address(0), "StableSwapPayoutHandler: outStable_ cannot be the zero address");
    _outStable = outSable_;

    _disableInitializers();
  }

  /**
   * @param name see {ERC721Upgradeable}
   * @param symbol see {ERC721Upgradeable}
   * @param cashflowLender_ ERC4626CashFlowLender for the creation of policies
   * @param swapConfig_  see {SwapLibrary.SwapConfig}
   * @param swapPrice_  Reference price for the stablecoin, expressed as Wad (18 decimals)
   * @param admin Account that will hold the GUARDIAN_ROLE and DEFAULT_ADMIN_ROLE initially
   */
  function initialize(
    string memory name,
    string memory symbol,
    ERC4626CashFlowLender cashflowLender_,
    SwapLibrary.SwapConfig memory swapConfig_,
    uint256 swapPrice_,
    address admin
  ) public initializer {
    __StableSwapPayoutHandler_init(name, symbol, cashflowLender_, swapConfig_, swapPrice_, admin);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __StableSwapPayoutHandler_init(
    string memory name_,
    string memory symbol_,
    ERC4626CashFlowLender cashflowLender_,
    SwapLibrary.SwapConfig memory swapConfig_,
    uint256 swapPrice_,
    address admin
  ) internal onlyInitializing {
    __UUPSUpgradeable_init();
    __AccessControl_init();
    __ERC721_init(name_, symbol_);
    __Pausable_init();
    __StableSwapPayoutHandler_init_unchained(cashflowLender_, swapConfig_, swapPrice_, admin);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __StableSwapPayoutHandler_init_unchained(
    ERC4626CashFlowLender cashflowLender_,
    SwapLibrary.SwapConfig memory swapConfig_,
    uint256 swapPrice_,
    address admin
  ) internal onlyInitializing {
    _cashflowLender = cashflowLender_;
    _pool = _cashflowLender.riskModule().policyPool();
    _setupRole(DEFAULT_ADMIN_ROLE, admin);

    _swapConfig = swapConfig_;
    _swapConfig.validate();
    emit SwapConfigChanged(swapConfig_);

    _swapPrice = swapPrice_;
    emit SwapPriceChanged(_swapPrice);
  }

  modifier onlyPolicyPool() {
    require(_msgSender() == address(_pool), "StableSwapPayoutHandler: The caller must be the PolicyPool");
    _;
  }

  /**
   * @param interfaceId see {IERC165}
   */
  function supportsInterface(
    bytes4 interfaceId
  ) public view virtual override(AccessControlUpgradeable, ERC721Upgradeable) returns (bool) {
    return
      AccessControlUpgradeable.supportsInterface(interfaceId) ||
      ERC721Upgradeable.supportsInterface(interfaceId) ||
      interfaceId == type(IPolicyHolder).interfaceId;
  }

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address newImplementation) internal override onlyRole(GUARDIAN_ROLE) {}

  /**
   * @notice Creates and wraps a new policy. See {ERC4626CashFlowLender.newPolicyOnBehalfOf} for the parameter details.
   */
  function newPolicyOnBehalfOf(
    address riskModule,
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    address onBehalfOf,
    uint256 bucketId,
    bytes32 policyData,
    bytes32 quoteSignatureR,
    bytes32 quoteSignatureVS,
    uint40 quoteValidUntil
  ) external onlyRole(POLICY_CREATOR_ROLE) returns (uint256 policyId) {
    policyId = (uint256(uint160(riskModule)) << 96) + uint96(uint256(policyData) % 2 ** 96);
    _safeMint(onBehalfOf, policyId);

    _cashflowLender.newPolicyOnBehalfOf(
      riskModule,
      payout,
      premium,
      lossProb,
      expiration,
      address(this),
      bucketId,
      policyData,
      quoteSignatureR,
      quoteSignatureVS,
      quoteValidUntil
    );
  }

  /**
   * @notice Creates and wraps a batch of new policies. See {ERC4626CashFlowLender.newPoliciesInBatchWithRm} for the parameter details.
   */
  function newPoliciesInBatchOnBehalfOf(
    address[] memory riskModules,
    uint256[] memory payout,
    uint256[] memory premium,
    uint256[] memory lossProb,
    uint40[] memory expiration,
    address[] memory onBehalfOf,
    uint256[] memory bucketId,
    bytes32[] memory policyData,
    bytes32[] memory quoteSignatureR,
    bytes32[] memory quoteSignatureVS,
    uint40[] memory quoteValidUntil
  ) external onlyRole(POLICY_CREATOR_ROLE) returns (uint256 policyId) {
    for (uint256 i = 0; i < riskModules.length; i++) {
      policyId = (uint256(uint160(riskModules[i])) << 96) + uint96(uint256(policyData[i]) % 2 ** 96);
      _safeMint(onBehalfOf[i], policyId);

      _cashflowLender.newPolicyOnBehalfOf(
        riskModules[i],
        payout[i],
        premium[i],
        lossProb[i],
        expiration[i],
        address(this),
        bucketId[i],
        policyData[i],
        quoteSignatureR[i],
        quoteSignatureVS[i],
        quoteValidUntil[i]
      );
    }
  }

  /**
   * @inheritdoc IERC721Receiver
   */
  function onERC721Received(
    address,
    address,
    uint256 tokenId,
    bytes calldata
  ) external virtual override onlyPolicyPool returns (bytes4) {
    require(_ownerOf(tokenId) != address(0), "StableSwapPayoutHandler: received unknown policy");
    return IERC721Receiver.onERC721Received.selector;
  }

  /**
   * @inheritdoc IPolicyHolder
   */
  function onPayoutReceived(
    address,
    address,
    uint256 tokenId,
    uint256 amount
  ) external virtual override onlyPolicyPool returns (bytes4) {
    address tokenOwner = _ownerOf(tokenId);
    require(tokenOwner != address(0), "StableSwapPayoutHandler: received unknown policy");
    _burn(tokenId);
    _swapConfig.exactOutput(address(currency()), address(outStable()), amount, _swapPrice);
    outStable().safeTransfer(tokenOwner, amount);
    return IPolicyHolder.onPayoutReceived.selector;
  }

  /**
   * @inheritdoc IPolicyHolder
   */
  function onPolicyExpired(
    address,
    address,
    uint256 tokenId
  ) external virtual override onlyPolicyPool returns (bytes4) {
    _burn(tokenId);
    return IPolicyHolder.onPolicyExpired.selector;
  }

  /**
   * @dev Sets the reference price for stablecoin swaps.
   *      Requires SWAP_PRICER_ROLE.
   *      Emits a SwapPriceChanged event.
   * @param newPrice The new price for the stablecoin, expressed as Wad (18 decimals)
   */
  function setSwapPrice(uint256 newPrice) external onlyRole(SWAP_PRICER_ROLE) {
    require(newPrice > 0, "StableSwapPayoutHandler: newPrice must be greater than 0");
    _swapPrice = newPrice;
    emit SwapPriceChanged(newPrice);
  }

  /**
   * @dev Unwraps the policy and transfers ownership to the owner.
   *      Only callable by the owner of the NFT.
   *      Emits a Transfer event.
   */
  function recoverPolicy(uint256 tokenId) external {
    require(ownerOf(tokenId) == _msgSender(), "StableSwapPayoutHandler: you must own the NFT to recover the policy");
    _burn(tokenId);
    IERC721(address(_pool)).safeTransferFrom(address(this), _msgSender(), tokenId);
  }

  function currency() public view returns (IERC20Metadata) {
    return _pool.currency();
  }

  function outStable() public view returns (IERC20Metadata) {
    return _outStable;
  }

  function cashflowLender() public view returns (ERC4626CashFlowLender) {
    return _cashflowLender;
  }

  function swapPrice() public view returns (uint256) {
    return _swapPrice;
  }

  function swapConfig() public view returns (SwapLibrary.SwapConfig memory) {
    return _swapConfig;
  }

  function pool() public view returns (IPolicyPool) {
    return _pool;
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[44] private __gap;
}
