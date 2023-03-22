// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.16;
import {IQuadReader} from "@quadrata/contracts/interfaces/IQuadReader.sol";
import {IQuadPassportStore} from "@quadrata/contracts/interfaces/IQuadPassportStore.sol";

/**
 * @dev Contract to expose passport attributes on events for improved test readability
 */
contract PassportInspector {
  event PassportAttributes(bytes32 attribute, bytes32 value);

  IQuadReader _reader;

  constructor(IQuadReader reader) {
    _reader = reader;
  }

  function getAttributesBulk(address account, bytes32[] calldata _attributes) public {
    IQuadPassportStore.Attribute[] memory attributes = _reader.getAttributesBulk(
      account,
      _attributes
    );

    for (uint256 i = 0; i < _attributes.length; i++) {
      emit PassportAttributes(_attributes[i], attributes[i].value);
    }
  }
}
