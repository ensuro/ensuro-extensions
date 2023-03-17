// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {LPManualWhitelist} from "@ensuro/core/contracts/LPManualWhitelist.sol";
import {IPolicyPool} from "@ensuro/core/contracts/interfaces/IPolicyPool.sol";
import {PolicyPoolComponent} from "@ensuro/core/contracts/PolicyPoolComponent.sol";

import {IQuadReader} from "@quadrata/contracts/interfaces/IQuadReader.sol";
import {IQuadPassportStore} from "@quadrata/contracts/interfaces/IQuadPassportStore.sol";
import {QuadReaderUtils} from "@quadrata/contracts/utility/QuadReaderUtils.sol";
import {QuadConstant} from "@quadrata/contracts/storage/QuadConstant.sol";

contract QuadrataWhitelist is LPManualWhitelist, QuadConstant {
  using QuadReaderUtils for bytes32;

  bytes32 public constant QUADRATA_WHITELIST_ROLE = keccak256("QUADRATA_WHITELIST_ROLE");

  IQuadReader internal _reader;

  WhitelistStatus internal _whitelistMode;

  bytes32[] internal _requiredAttributes;

  uint256 internal _requiredAMLScore;

  mapping(bytes32 => bool) _countryBlacklisted;

  event QuadrataWhitelistModeChanged(WhitelistStatus newMode);
  event RequiredAMLScoreChanged(uint256 requiredAMLScore);
  event CountryBlacklistChanged(bytes32 country, bool blacklisted);
  event RequiredAttributeAdded(bytes32 attribute);
  event RequiredAttributeRemoved(bytes32 attribute);

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(IPolicyPool policyPool_) LPManualWhitelist(policyPool_) {}

  /**
   *
   * @param defaultStatus The default status to use for undefined whitelist status
   * @param quadrataWhitelistMode The whitelist status to be used when whitelisting with quadrata
   * @param reader_ The QuadReader to be used
   */
  function initializeQ(
    WhitelistStatus calldata defaultStatus,
    WhitelistStatus calldata quadrataWhitelistMode,
    IQuadReader reader_,
    uint256 requiredAMLScore_,
    bytes32[] calldata requiredAttributes_
  ) public initializer {
    __QuadrataWhitelist_init(
      defaultStatus,
      quadrataWhitelistMode,
      reader_,
      requiredAMLScore_,
      requiredAttributes_
    );
  }

  // solhint-disable-next-line func-name-mixedcase
  function __QuadrataWhitelist_init(
    WhitelistStatus calldata defaultStatus,
    WhitelistStatus calldata quadrataWhitelistMode,
    IQuadReader reader_,
    uint256 requiredAMLScore_,
    bytes32[] calldata requiredAttributes_
  ) internal onlyInitializing {
    __LPManualWhitelist_init(defaultStatus);
    __QuadrataWhitelist_init_unchained(
      quadrataWhitelistMode,
      reader_,
      requiredAMLScore_,
      requiredAttributes_
    );
  }

  // solhint-disable-next-line func-name-mixedcase
  function __QuadrataWhitelist_init_unchained(
    WhitelistStatus calldata quadrataWhitelistMode,
    IQuadReader reader_,
    uint256 requiredAMLScore_,
    bytes32[] calldata requiredAttributes_
  ) internal onlyInitializing {
    _reader = reader_;

    for (uint256 i = 0; i < requiredAttributes_.length; i++) {
      _requiredAttributes.push(requiredAttributes_[i]);
      emit RequiredAttributeAdded(requiredAttributes_[i]);
    }

    _requiredAMLScore = requiredAMLScore_;
    emit RequiredAMLScoreChanged(_requiredAMLScore);

    _whitelistMode = quadrataWhitelistMode;
    emit QuadrataWhitelistModeChanged(_whitelistMode);
  }

  function _validateRequiredAttribute(
    bytes32 attributeKey,
    IQuadPassportStore.Attribute memory attribute
  ) internal view {
    require(
      attribute.value != bytes32(0),
      "User has no passport or is missing required attributes"
    );

    if (attributeKey == ATTRIBUTE_AML) {
      require(uint256(attribute.value) >= _requiredAMLScore, "AML score < required AML score");
    } else if (attributeKey == ATTRIBUTE_COUNTRY) {
      require(!_countryBlacklisted[attribute.value], "Country not allowed");
    }
  }

  function quadrataWhitelist(address provider) public onlyComponentRole(QUADRATA_WHITELIST_ROLE) {
    require(provider != address(0), "Provider cannot be the zero address");

    IQuadPassportStore.Attribute[] memory attributes = _reader.getAttributesBulk(
      provider,
      _requiredAttributes
    );

    require(attributes.length == _requiredAttributes.length, "Sanity check failed");

    for (uint256 i = 0; i < attributes.length; i++) {
      _validateRequiredAttribute(_requiredAttributes[i], attributes[i]);
    }

    _whitelistAddress(provider, _whitelistMode);
  }

  function setWhitelistMode(
    WhitelistStatus calldata newMode
  ) public onlyComponentRole(LP_WHITELIST_ADMIN_ROLE) {
    _whitelistMode = newMode;
    emit QuadrataWhitelistModeChanged(_whitelistMode);
  }

  function reader() external view virtual returns (IQuadReader) {
    return _reader;
  }

  function requiredAMLScore() external view virtual returns (uint256) {
    return _requiredAMLScore;
  }

  function setRequiredAMLScore(
    uint256 requiredAMLScore_
  ) external onlyComponentRole(LP_WHITELIST_ADMIN_ROLE) {
    _requiredAMLScore = requiredAMLScore_;
    emit RequiredAMLScoreChanged(_requiredAMLScore);
  }

  function countryBlacklisted(bytes32 country) external view virtual returns (bool) {
    return _countryBlacklisted[country];
  }

  function setCountryBlacklisted(
    bytes32 country,
    bool blacklisted
  ) external onlyComponentRole(LP_WHITELIST_ADMIN_ROLE) {
    _countryBlacklisted[country] = blacklisted;
    emit CountryBlacklistChanged(country, blacklisted);
  }

  function requiredAttributes() external view virtual returns (bytes32[] memory) {
    return _requiredAttributes;
  }

  function addRequiredAttribute(
    bytes32 attribute
  ) external onlyComponentRole(LP_WHITELIST_ADMIN_ROLE) {
    for (uint256 i = 0; i < _requiredAttributes.length; i++)
      if (_requiredAttributes[i] == attribute) return;

    // TODO: validate the attribute?
    _requiredAttributes.push(attribute);
    emit RequiredAttributeAdded(attribute);
  }

  function removeRequiredAttribute(
    bytes32 attribute
  ) external onlyComponentRole(LP_WHITELIST_ADMIN_ROLE) {
    for (uint256 i = 0; i < _requiredAttributes.length; i++)
      if (_requiredAttributes[i] == attribute) {
        _requiredAttributes[i] = _requiredAttributes[_requiredAttributes.length - 1];
        _requiredAttributes.pop();
        emit RequiredAttributeRemoved(attribute);
        return;
      }
  }
}
