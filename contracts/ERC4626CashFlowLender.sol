// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/interfaces/IERC20Upgradeable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title CashFlow Lender Module
 * @dev
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract ERC4626CashFlowLender is AccessControlUpgradeable, UUPSUpgradeable, ERC4626Upgradeable {
  bytes32 public constant LP_ROLE = keccak256("LP_ROLE");
  bytes32 public constant CUSTOMER_ROLE = keccak256("CUSTOMER_ROLE");
  bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

  int256 internal _debt;
  IERC20Metadata private immutable _asset;

  event DebtChanged(int256 currentDebt);

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(IERC20Metadata asset_) {
    _disableInitializers();
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

  /**
   * @dev Deposit/mint common workflow.
   */
  function _deposit(
    address caller,
    address receiver,
    uint256 assets,
    uint256 shares
  ) internal virtual override onlyRole(LP_ROLE) {
    _increaseDebt(assets);
    super._deposit(caller, receiver, assets, shares);
  }

  /**
   * @dev Withdraw/burn common workflow.
   */
  function _withdraw(
    address caller,
    address receiver,
    address owner,
    uint256 assets,
    uint256 shares
  ) internal virtual override onlyRole(CUSTOMER_ROLE) {
    require(_debt >= 0, "ERC4626CashFlowLender: cannot withdraw if there's debt with the customer");
    uint256 balance = IERC20Metadata(asset()).balanceOf(address(this));
    require(balance >= assets, "ERC4626CashFlowLender: not enough assets to withdraw");

    _decreaseDebt(assets);
    super._withdraw(caller, receiver, owner, assets, shares);
  }

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address newImpl) internal view override onlyRole(GUARDIAN_ROLE) {}
}
