const { expect } = require("chai");
const _ = require("lodash");
const {
  initCurrency,
  deployPool,
  deployPremiumsAccount,
  _W,
  addRiskModule,
  amountFunction,
  addEToken,
  getTransactionEvent,
  accessControlMessage,
} = require("@ensuro/core/js/test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

describe("EuroCashFlowLender contract tests", function () {
  let _A;
  let lp, cust, signer, resolver, creator, anon, guardian;

  beforeEach(async () => {
    [__, lp, cust, signer, resolver, creator, anon, owner, guardian] = await hre.ethers.getSigners();

    _A = amountFunction(6);
  });

  async function deployPoolFixture() {
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(50000) },
      [lp, cust, owner],
      [_A(5000), _A(500), _A(1000)]
    );

    const pool = await deployPool(hre, {
      currency: currency.address,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
    });
    pool._A = _A;

    const accessManager = await hre.ethers.getContractAt("AccessManager", await pool.access());

    // Setup the liquidity sources
    const etk = await addEToken(pool, {});
    const premiumsAccount = await deployPremiumsAccount(hre, pool, { srEtkAddr: etk.address });

    // Provide some liquidity
    await currency.connect(lp).approve(pool.address, _A(5000));
    await pool.connect(lp).deposit(etk.address, _A(5000));

    // Customer approval
    await currency.connect(cust).approve(pool.address, _A(500));

    // Setup the risk module
    const TrustfulRiskModule = await hre.ethers.getContractFactory("TrustfulRiskModule");
    const rm = await addRiskModule(pool, premiumsAccount, TrustfulRiskModule, {
      ensuroFee: 0.03,
    });

    await accessManager.grantComponentRole(rm.address, await rm.PRICER_ROLE(), signer.address);

    const EUR_USD_ORACLE_ADDRESS = "0x73366Fe0AA0Ded304479862808e02506FE556a98";
    const assetOracle = await hre.ethers.getContractAt("AggregatorV3Interface", EUR_USD_ORACLE_ADDRESS);

    const EuroCashFlowLender = await hre.ethers.getContractFactory("EuroCashFlowLender");
    const eurocfLender = await hre.upgrades.deployProxy(EuroCashFlowLender, [cust.address, _W("1.05")], {
      kind: "uups",
      unsafeAllow: ["delegatecall"],
      constructorArgs: [rm.address, assetOracle.address],
    });

    await accessManager.grantComponentRole(rm.address, await rm.PRICER_ROLE(), eurocfLender.address);
    await accessManager.grantComponentRole(rm.address, await rm.RESOLVER_ROLE(), eurocfLender.address);
    await eurocfLender.grantRole(await eurocfLender.OWNER_ROLE(), owner.address);
    await eurocfLender.grantRole(await eurocfLender.RESOLVER_ROLE(), resolver.address);
    await eurocfLender.grantRole(await eurocfLender.POLICY_CREATOR_ROLE(), creator.address);

    return { etk, premiumsAccount, rm, pool, accessManager, currency, eurocfLender, assetOracle };
  }

  it("EuroCashFlowLender init", async () => {
    const { rm, pool, eurocfLender, premiumsAccount, currency, assetOracle } = await helpers.loadFixture(
      deployPoolFixture
    );

    expect(await eurocfLender.riskModule()).to.equal(rm.address);
    expect(await eurocfLender.assetOracle()).to.equal(assetOracle.address);
    expect(await eurocfLender.customer()).to.equal(cust.address);
    expect(await eurocfLender.buffer()).to.equal(_W("1.05"));
  });

  it("Should not allow address(0) for the AssetOracle and RM", async () => {
    const { rm, assetOracle } = await helpers.loadFixture(deployPoolFixture);

    const EuroCashFlowLender = await hre.ethers.getContractFactory("EuroCashFlowLender");
    await expect(
      hre.upgrades.deployProxy(EuroCashFlowLender, [cust.address, _W("1.05")], {
        kind: "uups",
        unsafeAllow: ["delegatecall"],
        constructorArgs: [hre.ethers.constants.AddressZero, assetOracle.address],
      })
    ).to.be.revertedWith("EuroCashFlowLender: riskModule_ cannot be zero address");

    await expect(
      hre.upgrades.deployProxy(EuroCashFlowLender, [cust.address, _W("1.05")], {
        kind: "uups",
        unsafeAllow: ["delegatecall"],
        constructorArgs: [rm.address, hre.ethers.constants.AddressZero],
      })
    ).to.be.revertedWith("EuroCashFlowLender: assetOracle_ cannot be zero address");
  });
});
