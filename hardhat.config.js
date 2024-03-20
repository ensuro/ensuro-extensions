require("dotenv").config();

require("@nomicfoundation/hardhat-toolbox");
require("@nomicfoundation/hardhat-ethers");
require("@openzeppelin/hardhat-upgrades");
require("hardhat-dependency-compiler");
require("hardhat-contract-sizer");
require("solidity-coverage");
require("@nomicfoundation/hardhat-foundry");

// const exec = require("util").promisify(require("child_process").exec);
const { execSync } = require("child_process");
const { task } = require("hardhat/config");
const { TASK_TEST } = require("hardhat/builtin-tasks/task-names");

task(TASK_TEST, async function (args, hre, runSuper) {
  // Run forge tests
  await execSync("forge test", { stdio: "inherit" });

  // Run tests as usual
  await runSuper();
});

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
