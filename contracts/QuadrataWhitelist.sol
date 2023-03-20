// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {LPManualWhitelist} from "@ensuro/core/contracts/LPManualWhitelist.sol";
import {IPolicyPool} from "@ensuro/core/contracts/interfaces/IPolicyPool.sol";
import {PolicyPoolComponent} from "@ensuro/core/contracts/PolicyPoolComponent.sol";

import {IQuadReader} from "@quadrata/contracts/interfaces/IQuadReader.sol";
import {IQuadPassportStore} from "@quadrata/contracts/interfaces/IQuadPassportStore.sol";
import {QuadReaderUtils} from "@quadrata/contracts/utility/QuadReaderUtils.sol";

contract QuadrataWhitelist is LPManualWhitelist {
  using QuadReaderUtils for bytes32;

  bytes32 public constant QUADRATA_WHITELIST_ROLE = keccak256("QUADRATA_WHITELIST_ROLE");

  bytes32 internal constant ATTRIBUTE_COUNTRY = keccak256("COUNTRY");
  bytes32 internal constant ATTRIBUTE_AML = keccak256("AML");

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IQuadReader internal immutable _reader;

  WhitelistStatus internal _whitelistMode;

  bytes32[] internal _requiredAttributes;

  uint256 internal _requiredAMLScore;

  mapping(bytes32 => bool) internal _countryBlacklisted;

  event QuadrataWhitelistModeChanged(WhitelistStatus newMode);
  event RequiredAMLScoreChanged(uint256 requiredAMLScore);
  event CountryBlacklistChanged(bytes32 country, bool blacklisted);
  event RequiredAttributeAdded(bytes32 attribute);
  event RequiredAttributeRemoved(bytes32 attribute);
  event PassportAttribute(address indexed provider, bytes32 indexed attribute, bytes32 value);

  /**
   *
   * @param policyPool_ The policypool this whitelist belongs to
   * @param reader_ The QuadReader to be used
   */
  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(IPolicyPool policyPool_, IQuadReader reader_) LPManualWhitelist(policyPool_) {
    _reader = reader_;
  }

  /**
   *
   * @param defaultStatus The default status to use for undefined whitelist status
   * @param quadrataWhitelistMode The whitelist status to be used when whitelisting with quadrata
   * @param requiredAMLScore_ The minimum AML score required for whitelisting
   * @param requiredAttributes_ An array of attributes that are required for whitelisting.
   *                            Attributes are represented as the keccak hash of the attribute name.
   *                            Check quadrata's docs: https://docs.quadrata.com/integration/additional-information/constants#attributes
   */
  function initializeQuadrata(
    WhitelistStatus calldata defaultStatus,
    WhitelistStatus calldata quadrataWhitelistMode,
    uint256 requiredAMLScore_,
    bytes32[] calldata requiredAttributes_
  ) public initializer {
    __QuadrataWhitelist_init(
      defaultStatus,
      quadrataWhitelistMode,
      requiredAMLScore_,
      requiredAttributes_
    );
  }

  // solhint-disable-next-line func-name-mixedcase
  function __QuadrataWhitelist_init(
    WhitelistStatus calldata defaultStatus,
    WhitelistStatus calldata quadrataWhitelistMode,
    uint256 requiredAMLScore_,
    bytes32[] calldata requiredAttributes_
  ) internal onlyInitializing {
    __LPManualWhitelist_init(defaultStatus);
    __QuadrataWhitelist_init_unchained(
      quadrataWhitelistMode,
      requiredAMLScore_,
      requiredAttributes_
    );
  }

  // solhint-disable-next-line func-name-mixedcase
  function __QuadrataWhitelist_init_unchained(
    WhitelistStatus calldata quadrataWhitelistMode,
    uint256 requiredAMLScore_,
    bytes32[] calldata requiredAttributes_
  ) internal onlyInitializing {
    for (uint256 i = 0; i < requiredAttributes_.length; i++) {
      _requiredAttributes.push(requiredAttributes_[i]);
      emit RequiredAttributeAdded(requiredAttributes_[i]);
    }

    _requiredAMLScore = requiredAMLScore_;
    emit RequiredAMLScoreChanged(_requiredAMLScore);

    _whitelistMode = quadrataWhitelistMode;
    emit QuadrataWhitelistModeChanged(_whitelistMode);
  }

  /**
   * @dev Validates that the attribute exists, and for some attributes performs additional validations.
   *      Current validations:
   *        - AML > required AML score
   *        - Country not blacklisted
   * @param attributeKey The attribute that will be validated. See `requiredAttributes_` in `initializeQuadrata`
   * @param attribute The attribute itself as returned by QuadReader
   */
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

  /**
   * @dev Whitelist a provider that has a Quadrata passport with the required attributes.
   *      The provider will be whitelisted according to the whitelistMode.
   * @param provider The provider address.
   */
  function quadrataWhitelist(address provider) public onlyComponentRole(QUADRATA_WHITELIST_ROLE) {
    require(provider != address(0), "Provider cannot be the zero address");

    IQuadPassportStore.Attribute[] memory attributes = _reader.getAttributesBulk(
      provider,
      _requiredAttributes
    );

    require(attributes.length == _requiredAttributes.length, "Sanity check failed");

    for (uint256 i = 0; i < attributes.length; i++) {
      _validateRequiredAttribute(_requiredAttributes[i], attributes[i]);
      emit PassportAttribute(provider, _requiredAttributes[i], attributes[i].value);
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

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[46] private __gap;
}
