// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {IPolicyPool} from "@ensuro/core/contracts/interfaces/IPolicyPool.sol";
import {IPolicyHolder} from "@ensuro/core/contracts/interfaces/IPolicyHolder.sol";
import {SwapLibrary} from "@ensuro/swaplibrary/contracts/SwapLibrary.sol";

import {ERC4626CashFlowLender} from "./ERC4626CashFlowLender.sol";

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

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IERC20Metadata internal immutable _outStable;

  ERC4626CashFlowLender internal _cashflowLender;

  SwapLibrary.SwapConfig internal _swapConfig;

  event SwapConfigChanged(SwapLibrary.SwapConfig newConfig);

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(IERC20Metadata outSable_) {
    require(address(outSable_) != address(0), "StableSwapPayoutHandler: outStable_ cannot be the zero address");
    _outStable = outSable_;

    _disableInitializers();
  }

  function initialize(
    string memory name,
    string memory symbol,
    ERC4626CashFlowLender cashflowLender_,
    SwapLibrary.SwapConfig memory swapConfig_
  ) public initializer {
    // TODO: admin?
    __StableSwapPayoutHandler_init(name, symbol, cashflowLender_, swapConfig_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __StableSwapPayoutHandler_init(
    string memory name_,
    string memory symbol_,
    ERC4626CashFlowLender cashflowLender_,
    SwapLibrary.SwapConfig memory swapConfig_
  ) internal onlyInitializing {
    __UUPSUpgradeable_init();
    __AccessControl_init();
    __ERC721_init(name_, symbol_);
    __Pausable_init();
    __StableSwapPayoutHandler_init_unchained(cashflowLender_, swapConfig_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __StableSwapPayoutHandler_init_unchained(
    ERC4626CashFlowLender cashflowLender_,
    SwapLibrary.SwapConfig memory swapConfig_
  ) internal onlyInitializing {
    _cashflowLender = cashflowLender_;
    // TODO: add admin parameter or be consistent with CFL?
    _setupRole(DEFAULT_ADMIN_ROLE, _msgSender());

    _swapConfig = swapConfig_;
    _swapConfig.validate();
    emit SwapConfigChanged(swapConfig_);
  }

  modifier onlyPolicyPool() {
    require(_msgSender() == address(_pool()), "StableSwapPayoutHandler: The caller must be the PolicyPool");
    _;
  }

  function _pool() internal view returns (IPolicyPool) {
    return _cashflowLender.riskModule().policyPool();
  }

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

  function onERC721Received(
    address riskModule,
    address from,
    uint256 tokenId,
    bytes calldata data
  ) external virtual override onlyPolicyPool returns (bytes4) {
    require(ownerOf(tokenId) != address(0), "StableSwapPayoutHandler: received unknown policy");
    return IERC721Receiver.onERC721Received.selector;
  }

  function onPayoutReceived(
    address riskModule,
    address from,
    uint256 tokenId,
    uint256 amount
  ) external virtual override onlyPolicyPool returns (bytes4) {
    address tokenOwner = ownerOf(tokenId);
    require(tokenOwner != address(0), "StableSwapPayoutHandler: received unknown policy");
    _burn(tokenId);
    _swapConfig.exactOutput(address(currency()), address(outStable()), amount, 1e6); // TODO: use an oracle to get the price
    outStable().safeTransfer(tokenOwner, amount);
    return IPolicyHolder.onPayoutReceived.selector;
  }

  function onPolicyExpired(
    address,
    address,
    uint256 tokenId
  ) external virtual override onlyPolicyPool returns (bytes4) {
    _burn(tokenId);
    return IPolicyHolder.onPolicyExpired.selector;
  }

  function currency() public view returns (IERC20Metadata) {
    return _pool().currency();
  }

  function outStable() public view returns (IERC20Metadata) {
    return _outStable;
  }

  function cashflowLender() public view returns (ERC4626CashFlowLender) {
    return _cashflowLender;
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[46] private __gap;
}
