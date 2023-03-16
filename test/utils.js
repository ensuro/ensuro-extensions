/**
 * Chai test case wrapper for tests that require forking a live chain.
 *
 * It validates that the chain node URL is set, forks the chain at the specified block and adds the
 * block number to the test name.
 */
exports.fork = {
  it: (name, blockNumber, test) => {
    const skipForkTests = process.env.SKIP_FORK_TESTS === "true";
    const fullName = `[FORK ${blockNumber}] ${name}`;

    const wrapped = async (...args) => {
      if (process.env.ALCHEMY_URL === undefined) throw new Error("Define envvar ALCHEMY_URL for this test");

      await hre.network.provider.request({
        method: "hardhat_reset",
        params: [
          {
            forking: {
              jsonRpcUrl: process.env.ALCHEMY_URL,
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
