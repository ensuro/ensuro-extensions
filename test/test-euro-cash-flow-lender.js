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
const { newPolicy, defaultPolicyParams } = require("./test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

describe("EuroCashFlowLender contract tests", function () {
  let _A, _P;
  let lp, cust, signer, resolver, creator, anon, guardian;

  beforeEach(async () => {
    [__, lp, cust, signer, resolver, creator, anon, owner, guardian] = await hre.ethers.getSigners();

    _A = amountFunction(6);
    _P = amountFunction(8);
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

    const PriceOracle = await hre.ethers.getContractFactory("AggregatorV3Mock");
    const assetOracle = await PriceOracle.deploy(8);
    assetOracle._P = _P;

    const EuroCashFlowLender = await hre.ethers.getContractFactory("EuroCashFlowLender");
    const eurocfLender = await hre.upgrades.deployProxy(EuroCashFlowLender, [cust.address, _W("1.05")], {
      kind: "uups",
      unsafeAllow: ["delegatecall"],
      constructorArgs: [rm.address, assetOracle.address],
    });

    await accessManager.grantComponentRole(rm.address, await rm.RESOLVER_ROLE(), eurocfLender.address);
    await accessManager.grantComponentRole(rm.address, await rm.PRICER_ROLE(), eurocfLender.address);
    await accessManager.grantComponentRole(rm.address, await rm.PRICER_ROLE(), signer.address);
    await eurocfLender.grantRole(await eurocfLender.OWNER_ROLE(), owner.address);
    await eurocfLender.grantRole(await eurocfLender.PRICER_ROLE(), signer.address);
    await eurocfLender.grantRole(await eurocfLender.RESOLVER_ROLE(), resolver.address);
    await eurocfLender.grantRole(await eurocfLender.POLICY_CREATOR_ROLE(), creator.address);
    await eurocfLender.grantRole(await eurocfLender.GUARDIAN_ROLE(), guardian.address);

    return { etk, premiumsAccount, rm, pool, accessManager, currency, eurocfLender, assetOracle };
  }

  function makeQuoteMessage({ rmAddress, payout, premium, lossProb, expiration, policyData, validUntil }) {
    return ethers.utils.solidityPack(
      ["address", "uint256", "uint256", "uint256", "uint40", "bytes32", "uint40"],
      [rmAddress, payout, premium, lossProb, expiration, policyData, validUntil]
    );
  }

  function toCurrencyDecimals(amount) {
    return amount / 1e8;
  }

  it("EuroCashFlowLender init", async () => {
    const { rm, eurocfLender, assetOracle } = await helpers.loadFixture(deployPoolFixture);

    expect(await eurocfLender.riskModule()).to.equal(rm.address);
    expect(await eurocfLender.assetOracle()).to.equal(assetOracle.address);
    expect(await eurocfLender.customer()).to.equal(cust.address);
    expect(await eurocfLender.fxRiskBuffer()).to.equal(_W("1.05"));
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

  it("Creates a policy paid by the EuroCashFlowLender", async () => {
    const { pool, rm, eurocfLender, currency, assetOracle } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address, payout: _A(500), premium: _A(80) });
    const quoteMessage = makeQuoteMessage(policyParams);
    const signature = ethers.utils.splitSignature(await signer.signMessage(ethers.utils.arrayify(quoteMessage)));

    await expect(newPolicy(eurocfLender, creator, policyParams, cust, signature)).to.be.revertedWith(
      "ERC20: transfer amount exceeds balance" // No funds in eurocfLender
    );

    let [, assetPrice] = await assetOracle.latestRoundData();
    assetPrice = toCurrencyDecimals(assetPrice);

    expect(await currency.balanceOf(eurocfLender.address)).to.be.equal(_A(0));
    await currency.connect(owner).transfer(eurocfLender.address, _A(500));
    expect(await currency.balanceOf(eurocfLender.address)).to.be.equal(_A(500));

    const tx = await newPolicy(eurocfLender, creator, policyParams, cust, signature);
    const receipt = await tx.wait();
    expect(await currency.balanceOf(eurocfLender.address)).to.be.equal(_A(500) - _A(80) * assetPrice);
    expect(await eurocfLender.currentDebt()).to.be.equal(_A(80));

    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const policyId = newPolicyEvt.args[1].id;
    expect(await pool.ownerOf(policyId)).to.be.equal(eurocfLender.address);

    await eurocfLender.connect(resolver).resolvePolicy(newPolicyEvt.args[1], _A(400));
    expect(await eurocfLender.currentDebt()).to.be.equal(_A(80) - _A(400)); // 80 previous debt - 400 payout
  });

  it("Rejects if called by unauthorized user", async () => {
    const { rm, eurocfLender } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address, premium: _A(200) });
    const quoteMessage = makeQuoteMessage(policyParams);
    const signature = ethers.utils.splitSignature(await signer.signMessage(ethers.utils.arrayify(quoteMessage)));

    await expect(newPolicy(eurocfLender, anon, policyParams, cust, signature)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "POLICY_CREATOR_ROLE")
    );
  });

  it("Rejects if resolved by unauthorized user", async () => {
    const { rm, currency, pool, eurocfLender, assetOracle } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address, payout: _A(800), premium: _A(200) });
    const quoteMessage = makeQuoteMessage(policyParams);
    const signature = ethers.utils.splitSignature(await signer.signMessage(ethers.utils.arrayify(quoteMessage)));
    await currency.connect(owner).transfer(eurocfLender.address, _A(800));
    const tx = await newPolicy(eurocfLender, creator, policyParams, cust, signature);
    const receipt = await tx.wait();

    let [, assetPrice] = await assetOracle.latestRoundData();
    assetPrice = toCurrencyDecimals(assetPrice);

    expect(await currency.balanceOf(eurocfLender.address)).to.be.equal(_A(800) - _A(200) * assetPrice);
    expect(await eurocfLender.currentDebt()).to.be.equal(_A(200));
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    await expect(eurocfLender.connect(anon).resolvePolicy(newPolicyEvt.args[1], _A(800))).to.be.revertedWith(
      accessControlMessage(anon.address, null, "RESOLVER_ROLE")
    );
  });
});
