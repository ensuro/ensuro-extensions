const hre = require("hardhat");

/**
 * Chai test case wrapper for tests that require forking a live chain.
 *
 * It validates that the chain node URL is set, forks the chain at the specified block and adds the
 * block number to the test name.
 */
exports.fork = {
  it: (name, blockNumber, test, alchemyUrlEnv = "ALCHEMY_URL") => {
    const skipForkTests = process.env.SKIP_FORK_TESTS === "true";
    const fullName = `[FORK ${blockNumber}] ${name}`;

    // eslint-disable-next-line func-style
    const wrapped = async (...args) => {
      let alchemyUrl = process.env[alchemyUrlEnv];
      if (alchemyUrl === undefined) throw new Error(`Define envvar ${alchemyUrlEnv} for this test`);

      await hre.network.provider.request({
        method: "hardhat_reset",
        params: [
          {
            forking: {
              jsonRpcUrl: alchemyUrl,
              blockNumber: blockNumber,
            },
          },
        ],
      });

      return test(...args);
    };

    return (skipForkTests ? it.skip : it)(fullName, wrapped);
  },
};
