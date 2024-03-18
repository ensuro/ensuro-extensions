// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

contract AggregatorV3Mock is AggregatorV3Interface {
  string public constant description = "MockOracle";
  uint256 public constant version = 1;

  uint8 public immutable decimals;

  uint80 internal _latestRound;

  struct RoundData {
    uint80 roundId;
    int256 answer;
    uint256 startedAt;
    uint256 updatedAt;
    uint80 answeredInRound;
  }

  mapping(uint80 => RoundData) internal _rounds;

  address internal owner;

  constructor(uint8 decimals_) {
    decimals = decimals_;
    owner = msg.sender;
  }

  function getRoundData(
    uint80 _roundId
  )
    external
    view
    returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
  {
    RoundData memory round = _rounds[_roundId];

    return (round.roundId, round.answer, round.startedAt, round.updatedAt, round.answeredInRound);
  }

  function latestRoundData()
    external
    view
    returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
  {
    return this.getRoundData(_latestRound);
  }

  function _addRound(int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) public {
    require(msg.sender == owner, "Method meant for testing only");
    _latestRound += 1;
    _rounds[_latestRound] = RoundData(_latestRound, answer, startedAt, updatedAt, answeredInRound);
  }
}
