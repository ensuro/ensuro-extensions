require("dotenv").config();

require("@nomicfoundation/hardhat-toolbox");
require("@nomicfoundation/hardhat-ethers");
require("@openzeppelin/hardhat-upgrades");
require("hardhat-dependency-compiler");
require("hardhat-contract-sizer");
require("solidity-coverage");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.16",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  contractSizer: {
    alphaSort: true,
    runOnCompile: false,
    disambiguatePaths: false,
  },
  dependencyCompiler: {
    paths: [
      "@ensuro/core/contracts/PolicyPool.sol",
      "@ensuro/core/contracts/LPManualWhitelist.sol",
      "@ensuro/core/contracts/AccessManager.sol",
      "@ensuro/core/contracts/PremiumsAccount.sol",
      "@ensuro/core/contracts/TrustfulRiskModule.sol",
      "@ensuro/core/contracts/SignedQuoteRiskModule.sol",
      "@ensuro/core/contracts/EToken.sol",
      "@ensuro/core/contracts/mocks/TestCurrency.sol",
      "@ensuro/swaplibrary/contracts/mocks/SwapRouterMock.sol",
    ],
  },
};
