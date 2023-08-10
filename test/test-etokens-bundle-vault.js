const { expect } = require("chai");
const { _W, amountFunction, getTransactionEvent, accessControlMessage } = require("@ensuro/core/js/utils");
const {
  initCurrency,
  deployPool,
  deployPremiumsAccount,
  addRiskModule,
  addEToken,
} = require("@ensuro/core/js/test-utils");
const { RiskModuleParameter } = require("@ensuro/core/js/enums");
const { newPolicy, defaultPolicyParams, defaultBucketPolicyParams, newBucketPolicy } = require("./test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { MaxUint256 } = hre.ethers.constants;

const { ethers } = hre;
const { AddressZero } = ethers.constants;

describe("ETokensBundleVault contract tests", function () {
  let _A;
  let anon, borrower, changeRm, creator, cust, guardian, lp, lp2, owner, resolver, signer;

  beforeEach(async () => {
    [, lp, lp2, lp3, cust, signer, resolver, creator, anon, owner, guardian, changeRm, borrower] =
      await ethers.getSigners();

    _A = amountFunction(6);
  });

  async function deployPoolFixture() {
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(500000) },
      [lp, lp2, lp3, cust, owner],
      [_A(100000), _A(200000), _A(30000), _A(5000), _A(1000)]
    );

    const pool = await deployPool({
      currency: currency.address,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
    });
    pool._A = _A;

    const accessManager = await ethers.getContractAt("AccessManager", await pool.access());

    // Infinite approvals from LPs to pool
    await currency.connect(lp).approve(pool.address, MaxUint256);
    await currency.connect(lp2).approve(pool.address, MaxUint256);
    await currency.connect(lp3).approve(pool.address, MaxUint256);
    // Customer approval
    await currency.connect(cust).approve(pool.address, MaxUint256);

    const jrETKs = [];
    const srETKs = [];
    const pas = [];
    const rms = [];

    const TrustfulRiskModule = await ethers.getContractFactory("TrustfulRiskModule");

    // Setup - 3 PAs, each one with Sr and Jr EToken and one Trustfull RM
    for (let i = 0; i < 3; i++) {
      const jr = await addEToken(pool, {});
      const sr = await addEToken(pool, {});
      const pa = await deployPremiumsAccount(pool, { srEtkAddr: sr.address, jrEtkAddr: jr.address });
      const rm = await addRiskModule(pool, pa, TrustfulRiskModule, {
        rmName: `RM ${i}`,
        collRatio: 1,
        maxPayoutPerPolicy: 10000,
      });
      await rm.setParam(RiskModuleParameter.jrCollRatio, _W("0.4"));
      await rm.setParam(RiskModuleParameter.jrRoc, _W("0.5"));
      await accessManager.grantComponentRole(rm.address, await rm.PRICER_ROLE(), signer.address);
      await accessManager.grantComponentRole(rm.address, await rm.RESOLVER_ROLE(), signer.address);
      jrETKs.push(jr);
      srETKs.push(sr);
      pas.push(pa);
      rms.push(rm);
    }

    // Setup the liquidity sources
    const ETokensBundleVault = await ethers.getContractFactory("ETokensBundleVault");

    return { pool, currency, accessManager, jrETKs, srETKs, pas, rms, ETokensBundleVault };
  }

  it("Initializes only with correct parameters", async () => {
    const { ETokensBundleVault, jrETKs } = await helpers.loadFixture(deployPoolFixture);
    await expect(hre.upgrades.deployProxy(ETokensBundleVault, [[], []], { kind: "uups" })).to.be.revertedWith(
      "ETokensBundleVault: the vault must have always at least one ETK"
    );
    await expect(
      hre.upgrades.deployProxy(ETokensBundleVault, [[jrETKs[0].address], []], { kind: "uups" })
    ).to.be.revertedWith("ETokensBundleVault: etks and percentages lengths differ");
    await expect(
      hre.upgrades.deployProxy(ETokensBundleVault, [[jrETKs[0].address], [_W("0.4")]], { kind: "uups" })
    ).to.be.revertedWith("ETokensBundleVault: total percentage must be 100%");
    const allJrs = jrETKs.map((etk) => etk.address);
    await expect(
      hre.upgrades.deployProxy(ETokensBundleVault, [allJrs, Array(3).fill(_W("0.4"))], { kind: "uups" })
    ).to.be.revertedWith("ETokensBundleVault: total percentage must be 100%");
    let vault = await hre.upgrades.deployProxy(ETokensBundleVault, [allJrs, [_W("0.4"), _W("0.25"), _W("0.35")]], {
      kind: "uups",
    });
    const receipt = await vault.deployTransaction.wait();
    let events = getTransactionEvents(vault.interface, receipt, "UnderlyingChanged");
    expect(events.length).to.be.equal(3);
    expect(events.map((evt) => evt.args.index)).to.deep.equal([0, 1, 2]);
    expect(events.map((evt) => evt.args.etk)).to.deep.equal(allJrs);

    // Test it can't be initialized twice
    await expect(vault.initialize(allJrs, [_W("0.4"), _W("0.25"), _W("0.35")])).to.be.revertedWith(
      "Initializable: contract is already initialized"
    );

    const underlying = await vault.getUnderlying();
    expect(underlying[0].length).to.be.equal(3);
    expect(underlying[1].length).to.be.equal(3);
    expect(underlying[0]).to.deep.equal(allJrs);
    expect(underlying[1]).to.deep.equal([_W("0.4"), _W("0.25"), _W("0.35")]);
  });

  it("Checks implementation can't be initialized", async () => {
    const { ETokensBundleVault, jrETKs } = await helpers.loadFixture(deployPoolFixture);
    const impl = await ETokensBundleVault.deploy();
    const allJrs = jrETKs.map((etk) => etk.address);
    await expect(impl.initialize(allJrs, [_W("0.4"), _W("0.25"), _W("0.35")])).to.be.revertedWith(
      "Initializable: contract is already initialized"
    );
  });
});

/**
 * Finds events with a given name in the receipt
 * @param {Interface} interface The interface of the contract that contains the requested event
 * @param {TransactionReceipt} receipt Transaction receipt containing the events in the logs
 * @param {String} eventName The name of the event we are interested in
 * @returns array of {LogDescription}
 */
function getTransactionEvents(interface, receipt, eventName) {
  return receipt.logs
    .map((log) => {
      let parsedLog;
      try {
        parsedLog = interface.parseLog(log);
        if (parsedLog.name == eventName) return parsedLog;
      } catch (error) {}
      return null;
    })
    .filter((x) => x !== null);
}
