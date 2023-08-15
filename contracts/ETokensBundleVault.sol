// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {IPolicyPool} from "@ensuro/core/contracts/interfaces/IPolicyPool.sol";
import {EToken} from "@ensuro/core/contracts/EToken.sol";
import {ILPWhitelist} from "@ensuro/core/contracts/interfaces/ILPWhitelist.sol";
import {WadRayMath} from "@ensuro/core/contracts/dependencies/WadRayMath.sol";
import {MathUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";

/**
 * @title ERC-4626 vault that invests in several eTokens with fixed allocations
 * @dev Implements the ERC-4626 standard deploying the funds into several eTokens. On deposit, it split the user's
 * deposit into the eTokens based on the configured allocations. On withdrawal, it withdraws from the underlying
 * eTokens proportional to the current value.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract ETokensBundleVault is AccessControlUpgradeable, UUPSUpgradeable, ERC4626Upgradeable {
  using SafeERC20 for IERC20Metadata;
  using SafeCast for uint256;
  using WadRayMath for uint256;

  bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
  bytes32 public constant REBALANCE_ROLE = keccak256("REBALANCE_ROLE");
  bytes32 public constant CHANGE_PERCENTAGE_ROLE = keccak256("CHANGE_PERCENTAGE_ROLE");
  bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

  struct Underlying {
    EToken etk;
    uint16 percentage; // percentage stored with 4 decimals
  }

  Underlying[] internal _underlying;

  event UnderlyingChanged(EToken etk, uint256 index, uint256 percentage);

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  /**
   * @dev Initializes the ERC4626CashFlowLender
   */
  function initialize(
    EToken[] calldata etks,
    uint256[] calldata percentages
  ) public virtual initializer {
    __ETokensBundleVault_init(etks, percentages);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __ETokensBundleVault_init(
    EToken[] calldata etks,
    uint256[] calldata percentages
  ) internal onlyInitializing {
    __UUPSUpgradeable_init();
    __AccessControl_init();
    require(etks.length > 0, "ETokensBundleVault: the vault must have always at least one ETK");
    __ERC4626_init(IERC20Upgradeable(address(etks[0].policyPool().currency())));
    __ETokensBundleVault_init_unchained(etks, percentages);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __ETokensBundleVault_init_unchained(
    EToken[] calldata etks,
    uint256[] calldata percentages
  ) internal onlyInitializing {
    require(
      etks.length == percentages.length,
      "ETokensBundleVault: etks and percentages lengths differ"
    );
    _setupRole(DEFAULT_ADMIN_ROLE, _msgSender());

    IPolicyPool pool;
    uint256 totalPercentage;
    for (uint256 i; i < etks.length; i++) {
      if (i == 0) {
        pool = etks[0].policyPool();
      } else {
        require(
          pool == etks[i].policyPool(),
          "ETokensBundleVault: Can't mix eTokens from different PolicyPool"
        );
      }
      _underlying.push(Underlying(etks[i], _wadTo16(percentages[i])));
      emit UnderlyingChanged(etks[i], i, percentages[i]);
      totalPercentage += percentages[i];
    }
    /* WARNING: the user must check the etks are unique, they can't appear twice in the array */
    require(totalPercentage == 1e18, "ETokensBundleVault: total percentage must be 100%");

    // Infinite approval to the PolicyPool to pay the deposits
    pool.currency().approve(address(pool), type(uint256).max);
  }

  function _wadTo16(uint256 value) internal pure returns (uint16) {
    return (value / 10 ** 14).toUint16();
  }

  function _16ToWad(uint16 value) internal pure returns (uint256) {
    return uint256(value) * 10 ** 14;
  }

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address newImpl) internal view override onlyRole(GUARDIAN_ROLE) {}

  function policyPool() public view returns (IPolicyPool) {
    return _underlying[0].etk.policyPool();
  }

  function totalAssets() public view virtual override returns (uint256 ret) {
    for (uint256 i; i < _underlying.length; i++) {
      ret += _underlying[i].etk.balanceOf(address(this));
    }
    return ret;
  }

  /** @dev Returns the max deposit in a given EToken considering the minUtilizationRate setting */
  function _maxDepositInETK(EToken etk) internal view returns (uint256) {
    uint256 minUR = etk.minUtilizationRate();
    if (minUR == 0) return type(uint256).max;
    uint256 ts = etk.totalSupply();
    uint256 maxTS = etk.scr().wadDiv(minUR);
    if (ts >= maxTS) return 0;
    return maxTS - ts;
  }

  /** @dev Returns the amount withdrawable from a given eToken */
  function _maxWithdrawalInETK(EToken etk) internal view returns (uint256) {
    return MathUpgradeable.min(etk.balanceOf(address(this)), etk.totalWithdrawable());
  }

  /** @dev Returns if the users is whitelisted for deposit or withdrawal in all the eTokens */
  function _isWhitelisted(address receiver, bool forDeposit) internal view returns (bool ret) {
    for (uint256 i; i < _underlying.length; i++) {
      EToken etk = _underlying[i].etk;
      ILPWhitelist wl = etk.whitelist();
      if (
        (address(wl) != address(0)) &&
        !(forDeposit ? wl.acceptsDeposit(etk, receiver, 1) : wl.acceptsWithdrawal(etk, receiver, 1))
      ) return false;
    }
    return true;
  }

  /** @dev See {IERC4626-maxDeposit}. */
  function maxDeposit(address receiver) public view virtual override returns (uint256 ret) {
    if (!_isWhitelisted(receiver, true)) return 0;
    for (uint256 i; i < _underlying.length; i++) {
      ret += _maxDepositInETK(_underlying[i].etk);
      if (ret == type(uint256).max) return ret;
    }
    return ret;
  }

  /** @dev See {IERC4626-maxMint}. */
  function maxMint(address receiver) public view virtual override returns (uint256) {
    return _convertToShares(maxDeposit(receiver), MathUpgradeable.Rounding.Down);
  }

  /** @dev See {IERC4626-maxRedeem}. */
  function maxRedeem(address owner) public view virtual override returns (uint256) {
    return _convertToShares(maxWithdraw(owner), MathUpgradeable.Rounding.Down);
  }

  /** @dev See {IERC4626-maxWithdraw}. */
  function maxWithdraw(address owner) public view virtual override returns (uint256 ret) {
    if (!_isWhitelisted(owner, false)) return 0;
    uint256 userBalance = _convertToAssets(balanceOf(owner), MathUpgradeable.Rounding.Down);
    for (uint256 i; i < _underlying.length; i++) {
      ret += _maxWithdrawalInETK(_underlying[i].etk);
      if (ret >= userBalance) return userBalance;
    }
    return ret;
  }

  function _depositProportional(IPolicyPool pool, uint256 assets) internal returns (uint256) {
    uint256 toDeposit;
    uint256 left = assets;
    uint256 last = _underlying.length - 1;
    // Deposit proportional in all but the last one
    for (uint256 i; i < last; i++) {
      toDeposit = MathUpgradeable.min(
        assets.wadMul(_16ToWad(_underlying[i].percentage)).wadDiv(WadRayMath.WAD),
        _maxDepositInETK(_underlying[i].etk)
      );
      if (toDeposit != 0) {
        pool.deposit(_underlying[i].etk, toDeposit);
        left -= toDeposit;
      }
    }
    toDeposit = MathUpgradeable.min(left, _maxDepositInETK(_underlying[last].etk));
    if (toDeposit != 0) {
      pool.deposit(_underlying[last].etk, toDeposit);
    }
    return left - toDeposit;
  }

  function _depositFirst(IPolicyPool pool, uint256 amount) internal returns (uint256) {
    for (uint256 i; i < _underlying.length; i++) {
      uint256 toDeposit = MathUpgradeable.min(amount, _maxDepositInETK(_underlying[i].etk));
      if (toDeposit != 0) {
        pool.deposit(_underlying[i].etk, toDeposit);
        amount -= toDeposit;
        if (amount == 0) return 0;
      }
    }
    return amount;
  }

  function _depositInUnderlying(uint256 assets) internal {
    uint256 left = _depositProportional(policyPool(), assets);
    if (left != 0) {
      // Try to allocate again
      left = _depositFirst(policyPool(), left);
    }
    require(left == 0, "ETokensBundleVault: couldn't allocate all the deposit");
  }

  function _deposit(
    address caller,
    address receiver,
    uint256 assets,
    uint256 shares
  ) internal virtual override {
    super._deposit(caller, receiver, assets, shares);
    _depositInUnderlying(assets);
  }

  function _withdrawProportional(
    IPolicyPool pool,
    uint256 assets,
    uint256 totalAssets_
  ) internal returns (uint256) {
    uint256 toWithdraw;
    uint256 left = assets;
    uint256 last = _underlying.length - 1;
    // Withdraw proportional to share of totalAssets in all but the last one
    for (uint256 i; i < last; i++) {
      toWithdraw = _underlying[i].etk.balanceOf(address(this));
      toWithdraw = MathUpgradeable.min(
        assets.wadMul(toWithdraw.wadDiv(totalAssets_)),
        _underlying[i].etk.totalWithdrawable()
      );
      if (toWithdraw != 0) {
        left -= pool.withdraw(_underlying[i].etk, toWithdraw);
      }
    }
    toWithdraw = MathUpgradeable.min(left, _underlying[last].etk.totalWithdrawable());
    if (toWithdraw != 0) {
      pool.withdraw(_underlying[last].etk, toWithdraw);
    }
    return left - toWithdraw;
  }

  function _withdrawFirst(IPolicyPool pool, uint256 amount) internal returns (uint256) {
    for (uint256 i; i < _underlying.length; i++) {
      uint256 toWithdraw = MathUpgradeable.min(amount, _maxWithdrawalInETK(_underlying[i].etk));
      if (toWithdraw != 0) {
        amount -= pool.withdraw(_underlying[i].etk, toWithdraw);
        if (amount == 0) return 0;
      }
    }
    return amount;
  }

  function _withdraw(
    address caller,
    address receiver,
    address owner,
    uint256 assets,
    uint256 shares
  ) internal virtual override {
    uint256 left = _withdrawProportional(policyPool(), assets, totalAssets());
    if (left != 0) {
      // Try to allocate again
      left = _withdrawFirst(policyPool(), left);
    }
    require(left == 0, "ETokensBundleVault: couldn't withdraw the required amount");
    super._withdraw(caller, receiver, owner, assets, shares);
  }

  function addEToken(EToken newETK, uint256[] calldata percentages) external onlyRole(ADMIN_ROLE) {
    require(
      percentages.length == _underlying.length + 1,
      "ETokensBundleVault: must send the new percentages"
    );
    require(
      policyPool() == newETK.policyPool(),
      "ETokensBundleVault: Can't mix eTokens from different PolicyPool"
    );
    uint256 totalPercentage;
    for (uint256 i; i < _underlying.length; i++) {
      require(newETK != _underlying[i].etk, "ETokensBundleVault: eToken already in the bundle");
      totalPercentage += percentages[i];
      _underlying[i].percentage = _wadTo16(percentages[i]);
      emit UnderlyingChanged(_underlying[i].etk, i, percentages[i]);
    }
    totalPercentage += percentages[_underlying.length];
    emit UnderlyingChanged(newETK, _underlying.length, percentages[_underlying.length]);
    _underlying.push(Underlying(newETK, _wadTo16(percentages[_underlying.length])));

    require(totalPercentage == 1e18, "ETokensBundleVault: total percentage must be 100%");
  }

  function removeEToken(
    EToken etkToRemove,
    uint256[] calldata percentages
  ) external onlyRole(ADMIN_ROLE) {
    require(
      percentages.length == _underlying.length - 1 && percentages.length != 0,
      "ETokensBundleVault: must send the new percentages"
    );
    uint256 totalPercentage;
    bool found;
    for (uint256 i; i < _underlying.length - 1; i++) {
      if (!found) {
        found = etkToRemove == _underlying[i].etk;
      }
      if (found) {
        _underlying[i].etk = _underlying[i + 1].etk;
      }
      _underlying[i].percentage = _wadTo16(percentages[i]);
      emit UnderlyingChanged(_underlying[i].etk, i, percentages[i]);
      totalPercentage += percentages[i];
    }
    require(
      found || _underlying[_underlying.length - 1].etk == etkToRemove,
      "ETokensBundleVault: token to remove not found!"
    );
    require(totalPercentage == 1e18, "ETokensBundleVault: total percentage must be 100%");
    _underlying.pop();
    emit UnderlyingChanged(etkToRemove, type(uint256).max, type(uint256).max);
    // Withdraw all the funds from removed eToken and deposit them
    uint256 balance = etkToRemove.balanceOf(address(this));
    if (balance != 0) {
      policyPool().withdraw(etkToRemove, balance);
      // NOTE: withdraw with the balanceOf will revert if not all the funds can be withdrawn
      _depositInUnderlying(balance);
    }
  }

  function changePercentages(
    uint256[] calldata percentages
  ) external onlyRole(CHANGE_PERCENTAGE_ROLE) {
    require(
      percentages.length == _underlying.length,
      "ETokensBundleVault: must send the new percentages"
    );
    uint256 totalPercentage;
    for (uint256 i; i < _underlying.length; i++) {
      _underlying[i].percentage = _wadTo16(percentages[i]);
      emit UnderlyingChanged(_underlying[i].etk, i, percentages[i]);
      totalPercentage += percentages[i];
    }
    require(totalPercentage == 1e18, "ETokensBundleVault: total percentage must be 100%");
  }

  function rebalance(uint256 from_, uint256 to_, uint256 amount) external onlyRole(REBALANCE_ROLE) {
    amount = policyPool().withdraw(_underlying[from_].etk, amount);
    policyPool().deposit(_underlying[to_].etk, amount);
  }

  function getUnderlying()
    external
    view
    returns (EToken[] memory etks, uint256[] memory percentages)
  {
    etks = new EToken[](_underlying.length);
    percentages = new uint256[](_underlying.length);
    for (uint256 i; i < _underlying.length; i++) {
      etks[i] = _underlying[i].etk;
      percentages[i] = _16ToWad(_underlying[i].percentage);
    }
    return (etks, percentages);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[49] private __gap;
}
