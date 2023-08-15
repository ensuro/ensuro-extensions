const { expect } = require("chai");
const { _W, amountFunction, getTransactionEvent, accessControlMessage } = require("@ensuro/core/js/utils");
const {
  initCurrency,
  deployPool,
  deployPremiumsAccount,
  addRiskModule,
  addEToken,
} = require("@ensuro/core/js/test-utils");
const { RiskModuleParameter, WhitelistStatus } = require("@ensuro/core/js/enums");
const { newPolicy, defaultPolicyParams, defaultBucketPolicyParams, newBucketPolicy } = require("./test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { MaxUint256 } = hre.ethers.constants;

const { ethers } = hre;
const { AddressZero } = ethers.constants;

describe("ETokensBundleVault contract tests", function () {
  let _A;
  let anon, borrower, changeRm, creator, cust, guardian, lp, lp2, owner, resolver, signer;
  let CENTS;
  let ONE;

  beforeEach(async () => {
    [, lp, lp2, lp3, cust, signer, resolver, creator, anon, owner, guardian, changeRm, borrower] =
      await ethers.getSigners();

    _A = amountFunction(6);
    CENTS = _A("0.0001");
    ONE = _A("0.000001");
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

    const LPManualWhitelist = await ethers.getContractFactory("LPManualWhitelist");
    const TrustfulRiskModule = await ethers.getContractFactory("TrustfulRiskModule");

    const wl = await hre.upgrades.deployProxy(
      LPManualWhitelist,
      [[WhitelistStatus.blacklisted, WhitelistStatus.blacklisted, WhitelistStatus.whitelisted, WhitelistStatus.whitelisted]],
      {
        constructorArgs: [pool.address],
        kind: "uups",
      }
    );

    // Setup - 3 PAs, each one with Sr and Jr EToken and one Trustfull RM
    for (let i = 0; i < 3; i++) {
      const jr = await addEToken(pool, {});
      const sr = await addEToken(pool, {});
      if (i % 2 == 0) {
        await jr.setWhitelist(wl.address);  // jr 0 and 2 will have WL
      } else {
        await sr.setWhitelist(wl.address);  // sr 1 will have WL
      }
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

  it.only("Checks deposits and withdrawals without restrictions", async () => {
    const { ETokensBundleVault, jrETKs, srETKs, currency, pool } = await helpers.loadFixture(deployPoolFixture);
    const etks = [jrETKs[1], srETKs[0], srETKs[2]];  // etks without WL
    let vault = await hre.upgrades.deployProxy(ETokensBundleVault, [etks.map((etk) => etk.address),
      [_W("0.4"), _W("0.25"), _W("0.35")]],
      {
        kind: "uups",
      }
    );

    expect(await vault.maxDeposit(anon.address)).to.be.equal(MaxUint256);
    expect(await vault.maxMint(anon.address)).to.be.equal(MaxUint256);

    await expect(vault.connect(lp).deposit(_A(1000), lp.address)).to.be.revertedWith(
      "ERC20: insufficient allowance"
    );

    // LP1 deposits 1K
    await currency.connect(lp).approve(vault.address, MaxUint256);
    await expect(vault.connect(lp).deposit(_A(1000), lp.address)).to.emit(
      vault, "Deposit"
    ).withArgs(lp.address, lp.address, _A(1000), _A(1000));

    // LP2 deposits 2K to anon
    await currency.connect(lp2).approve(vault.address, MaxUint256);
    await expect(vault.connect(lp2).deposit(_A(2000), anon.address)).to.emit(
      vault, "Deposit"
    ).withArgs(lp2.address, anon.address, _A(2000), _A(2000));

    expect(await vault.totalAssets()).to.be.equal(_A(3000));
    expect(await vault.totalSupply()).to.be.equal(_A(3000));
    expect(await vault.balanceOf(lp.address)).to.be.equal(_A(1000));
    expect(await vault.balanceOf(lp2.address)).to.be.equal(_A(0));
    expect(await vault.balanceOf(anon.address)).to.be.equal(_A(2000));

    expect(await etks[0].balanceOf(vault.address)).to.be.equal(_A(1200));  // 3000 * .4
    expect(await etks[1].balanceOf(vault.address)).to.be.equal(_A(750));  // 3000 * .25
    expect(await etks[2].balanceOf(vault.address)).to.be.equal(_A(1050));  // 3000 * .35

    // LP3 deposits some funds to etks[0] directly and gifts them to the vault (easy way to simulate a return)
    await pool.connect(lp3).deposit(etks[0].address, _A(1500));
    await etks[0].connect(lp3).transfer(vault.address, _A(1500));
    expect(await vault.totalAssets()).to.be.equal(_A(4500));
    expect(await vault.totalSupply()).to.be.equal(_A(3000));

    expect(await vault.maxWithdraw(lp.address)).to.be.closeTo(_A(1500), CENTS); // 1/3 of the total assets
    expect(await vault.maxRedeem(lp.address)).to.be.closeTo(_A(1000), ONE);
    expect(await vault.maxWithdraw(anon.address)).to.be.closeTo(_A(3000), CENTS); // 2/3 of the total assets
    expect(await vault.maxRedeem(anon.address)).to.be.closeTo(_A(2000), ONE);

    // LP1 withdraws 1000
    let before = await currency.balanceOf(lp.address);
    await expect(vault.connect(lp).withdraw(_A(1000), lp.address, lp.address)).to.emit(
      vault, "Withdraw"
    ).withArgs(lp.address, lp.address, lp.address, _A(1000), _A("666.666667"));
    expect(await currency.balanceOf(lp.address)).to.be.equal(before.add(_A(1000)));

    // Check it was withdrawn proportional to assets
    expect(await etks[0].balanceOf(vault.address)).to.be.equal(_A(1200 + 1500 - 600));  // 60% of the assets
    expect(await etks[1].balanceOf(vault.address)).to.be.equal(_A(750).sub(_A("166.666667")));  // 16.67%
    expect(await etks[2].balanceOf(vault.address)).to.be.equal(_A(1050).sub(_A("233.333333")));  // 23.33%

    // LP1 redeems all its shares
    before = await currency.balanceOf(lp.address);
    await expect(vault.connect(lp).redeem((await vault.balanceOf(lp.address)).sub(ONE), lp.address, lp.address)).to.emit(
      vault, "Withdraw"
    ).withArgs(lp.address, lp.address, lp.address, _A("499.999998"), _A("333.333332"));
    expect(await currency.balanceOf(lp.address)).to.be.closeTo(before.add(_A(500)), CENTS);

    // anon redeems all its shares
    before = await currency.balanceOf(anon.address);
    await expect(vault.connect(anon).redeem(await vault.balanceOf(anon.address), anon.address, anon.address)).to.emit(
      vault, "Withdraw"
    ).withArgs(anon.address, anon.address, anon.address, _A("3000"), _A("2000"));
    expect(await currency.balanceOf(anon.address)).to.be.closeTo(before.add(_A(3000)), CENTS);


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
