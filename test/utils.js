const hre = require("hardhat");

/**
 * Chai test case wrapper for tests that require forking a live chain.
 *
 * It validates that the chain node URL is set, forks the chain at the specified block and adds the
 * block number to the test name.
 */
const fork = {
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

// TODO: integrate this into ensuro utils. It's backwards-compatible.
/**
 * Finds an event in the receipt
 * @param {Interface} interface The interface of the contract that contains the requested event
 * @param {TransactionReceipt} receipt Transaction receipt containing the events in the logs
 * @param {String} eventName The name of the event we are interested in
 * @returns {LogDescription}
 */
function getTransactionEvent(interface, receipt, eventName, firstOnly = true) {
  // for each log in the transaction receipt
  const ret = [];
  for (const log of receipt.logs) {
    let parsedLog;
    try {
      parsedLog = interface.parseLog(log);
    } catch (error) {
      continue;
    }
    if (parsedLog?.name == eventName) {
      ret.push(parsedLog);
    }
  }
  return firstOnly ? ret[0] || null : ret;
}

module.exports = {
  fork,
  getTransactionEvent,
};
