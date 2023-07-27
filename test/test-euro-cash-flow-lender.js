const { expect } = require("chai");
const {
  _W,
  amountFunction,
  getTransactionEvent,
  accessControlMessage,
  makeSignedQuote,
} = require("@ensuro/core/js/utils");
const {
  initCurrency,
  deployPool,
  deployPremiumsAccount,
  addRiskModule,
  addEToken,
} = require("@ensuro/core/js/test-utils");
const { newPolicy, defaultPolicyParams } = require("./test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const HOUR = 3600;
const HALF_HOUR = HOUR / 2;

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

    const pool = await deployPool({
      currency: currency.address,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
    });
    pool._A = _A;

    const accessManager = await hre.ethers.getContractAt("AccessManager", await pool.access());

    // Setup the liquidity sources
    const etk = await addEToken(pool, {});
    const premiumsAccount = await deployPremiumsAccount(pool, { srEtkAddr: etk.address });

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
    const eurocfLender = await hre.upgrades.deployProxy(EuroCashFlowLender, [_W("1.05")], {
      kind: "uups",
      constructorArgs: [rm.address, assetOracle.address],
    });

    await accessManager.grantComponentRole(rm.address, await rm.RESOLVER_ROLE(), eurocfLender.address);
    await accessManager.grantComponentRole(rm.address, await rm.PRICER_ROLE(), eurocfLender.address);
    await eurocfLender.grantRole(await eurocfLender.OWNER_ROLE(), owner.address);
    await eurocfLender.grantRole(await eurocfLender.PRICER_ROLE(), signer.address);
    await eurocfLender.grantRole(await eurocfLender.RESOLVER_ROLE(), resolver.address);
    await eurocfLender.grantRole(await eurocfLender.POLICY_CREATOR_ROLE(), creator.address);
    await eurocfLender.grantRole(await eurocfLender.GUARDIAN_ROLE(), guardian.address);
    await eurocfLender.grantRole(await eurocfLender.CUSTOMER_ROLE(), cust.address);

    return { etk, premiumsAccount, rm, pool, accessManager, currency, eurocfLender, assetOracle };
  }

  function toCurrencyDecimals(amount) {
    return amount / 1e8;
  }

  async function addRound(oracle, price, startedAt, updatedAt, answeredInRound) {
    const now = await helpers.time.latest();
    return oracle._addRound(price, startedAt || now, updatedAt || now, answeredInRound || 0);
  }

  it("EuroCashFlowLender init", async () => {
    const { rm, eurocfLender, assetOracle } = await helpers.loadFixture(deployPoolFixture);

    expect(await eurocfLender.riskModule()).to.equal(rm.address);
    expect(await eurocfLender.assetOracle()).to.equal(assetOracle.address);
    expect(await eurocfLender.fxRiskBuffer()).to.equal(_W("1.05"));
  });

  it("EuroCashFlowLender set buffer", async () => {
    const { eurocfLender } = await helpers.loadFixture(deployPoolFixture);

    expect(await eurocfLender.fxRiskBuffer()).to.equal(_W("1.05"));

    await expect(eurocfLender.connect(anon).setBuffer(_W("1.05"))).to.be.revertedWith(
      accessControlMessage(anon.address, null, "OWNER_ROLE")
    );

    await expect(eurocfLender.connect(owner).setBuffer(_W("1.10")))
      .to.emit(eurocfLender, "FxRiskBufferChanged")
      .withArgs(_W("1.10"));

    expect(await eurocfLender.fxRiskBuffer()).to.equal(_W("1.10"));
  });

  it("Should not allow address(0) for the AssetOracle and RM", async () => {
    const { rm, assetOracle } = await helpers.loadFixture(deployPoolFixture);

    const EuroCashFlowLender = await hre.ethers.getContractFactory("EuroCashFlowLender");
    await expect(
      hre.upgrades.deployProxy(EuroCashFlowLender, [cust.address, _W("1.05")], {
        kind: "uups",
        constructorArgs: [hre.ethers.constants.AddressZero, assetOracle.address],
      })
    ).to.be.revertedWith("EuroCashFlowLender: riskModule_ cannot be zero address");

    await expect(
      hre.upgrades.deployProxy(EuroCashFlowLender, [cust.address, _W("1.05")], {
        kind: "uups",
        constructorArgs: [rm.address, hre.ethers.constants.AddressZero],
      })
    ).to.be.revertedWith("EuroCashFlowLender: assetOracle_ cannot be zero address");
  });

  it("Creates a policy paid by the EuroCashFlowLender", async () => {
    const { pool, rm, eurocfLender, currency, assetOracle } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address, payout: _A(500), premium: _A(80) });
    const signature = await makeSignedQuote(signer, policyParams);

    const now = await helpers.time.latest();
    await addRound(assetOracle, 108919000, now - HOUR * 2, now - HALF_HOUR);
    let [, assetPrice] = await assetOracle.latestRoundData();
    assetPrice = toCurrencyDecimals(assetPrice);

    await expect(newPolicy(eurocfLender, creator, policyParams, cust, signature)).to.be.revertedWith(
      "ERC20: transfer amount exceeds balance" // No funds in eurocfLender
    );

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

    await expect(eurocfLender.connect(owner).withdraw(_A(100), cust.address)).to.be.revertedWith(
      "EuroCashFlowLender: cannot withdraw if there's debt with the customer"
    );
  });

  it("Rejects if called by unauthorized user", async () => {
    const { rm, eurocfLender } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address, premium: _A(200) });
    const signature = await makeSignedQuote(signer, policyParams);

    await expect(newPolicy(eurocfLender, anon, policyParams, cust, signature)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "POLICY_CREATOR_ROLE")
    );
  });

  it("Rejects if resolved by unauthorized user", async () => {
    const { rm, currency, pool, eurocfLender, assetOracle } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address, payout: _A(800), premium: _A(200) });
    const signature = await makeSignedQuote(signer, policyParams);

    const now = await helpers.time.latest();
    await addRound(assetOracle, 108919000, now - HOUR * 2, now - HALF_HOUR);
    let [, assetPrice] = await assetOracle.latestRoundData();
    assetPrice = toCurrencyDecimals(assetPrice);

    await currency.connect(owner).transfer(eurocfLender.address, _A(800));
    const tx = await newPolicy(eurocfLender, creator, policyParams, cust, signature);
    const receipt = await tx.wait();

    expect(await currency.balanceOf(eurocfLender.address)).to.be.equal(_A(800) - _A(200) * assetPrice);
    expect(await eurocfLender.currentDebt()).to.be.equal(_A(200));
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    await expect(eurocfLender.connect(anon).resolvePolicy(newPolicyEvt.args[1], _A(800))).to.be.revertedWith(
      accessControlMessage(anon.address, null, "RESOLVER_ROLE")
    );

    expect(await eurocfLender.currentDebt()).to.be.equal(_A(200));
    await expect(eurocfLender.repayDebt(_A(800))).to.be.revertedWith(
      "EuroCashFlowLender: amount must be less than debt"
    );
    await currency.connect(cust).approve(eurocfLender.address, _A(300));
    await expect(eurocfLender.connect(cust).repayDebt(_A(200)))
      .to.emit(eurocfLender, "DebtChanged")
      .withArgs(_A(0));

    expect(await eurocfLender.currentDebt()).to.be.equal(_A(0));
  });

  it("Address without OWNER_ROLE can't withdraw", async () => {
    const { rm, eurocfLender, currency, assetOracle } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address, payout: _A(800), premium: _A(200) });
    const signature = await makeSignedQuote(signer, policyParams);

    const now = await helpers.time.latest();
    await addRound(assetOracle, 108919000, now - HOUR * 2, now - HALF_HOUR);
    let [, assetPrice] = await assetOracle.latestRoundData();
    assetPrice = toCurrencyDecimals(assetPrice);

    await currency.connect(owner).transfer(eurocfLender.address, _A(800));
    await newPolicy(eurocfLender, creator, policyParams, cust, signature);

    await expect(eurocfLender.connect(anon).withdraw(_A(800), owner.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "OWNER_ROLE")
    );
  });

  it("Only GUARDIAN_ROLE can upgrade", async () => {
    const { pool, eurocfLender, premiumsAccount } = await helpers.loadFixture(deployPoolFixture);

    // Setup the risk module
    const TrustfulRiskModule = await hre.ethers.getContractFactory("TrustfulRiskModule");
    const newImpl = await TrustfulRiskModule.deploy(pool.address, premiumsAccount.address);

    await expect(eurocfLender.connect(anon).upgradeTo(newImpl.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "GUARDIAN_ROLE")
    );

    await eurocfLender.connect(guardian).upgradeTo(newImpl.address);
  });

  it("Customer cashout", async () => {
    const { rm, pool, eurocfLender, currency, assetOracle } = await helpers.loadFixture(deployPoolFixture);
    let policyParams = await defaultPolicyParams({ rmAddress: rm.address, payout: _A(800), premium: _A(200) });
    let signature = await makeSignedQuote(signer, policyParams);

    const now = await helpers.time.latest();
    await addRound(assetOracle, 108919000, now - HOUR * 2, now - HALF_HOUR);
    let [, assetPrice] = await assetOracle.latestRoundData();
    assetPrice = toCurrencyDecimals(assetPrice);

    await currency.connect(owner).transfer(eurocfLender.address, _A(1000));
    let tx = await newPolicy(eurocfLender, creator, policyParams, cust, signature);
    let receipt = await tx.wait();
    expect(await eurocfLender.currentDebt()).to.be.equal(_A(200));
    let newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    await expect(eurocfLender.connect(resolver).resolvePolicy(newPolicyEvt.args[1], _A(150)))
      .to.emit(eurocfLender, "DebtChanged")
      .withArgs(_A(50));
    expect(await eurocfLender.currentDebt()).to.be.equal(_A(50));

    // 2nd Policy
    policyParams = await defaultPolicyParams({
      rmAddress: rm.address,
      premium: _A(100),
      payout: _A(500),
      policyData: "0x2cbef6744ebcff4969e06c41631a1d0aa71366c4fd997e9ff5a59b8efa9b9032",
    });
    signature = await makeSignedQuote(signer, policyParams);

    await expect(newPolicy(eurocfLender, anon, policyParams, cust, signature, "newPolicyFull")).to.be.revertedWith(
      accessControlMessage(anon.address, null, "POLICY_CREATOR_ROLE")
    );

    tx = await newPolicy(eurocfLender, creator, policyParams, cust, signature, "newPolicyFull");
    receipt = await tx.wait();
    expect(await eurocfLender.currentDebt()).to.be.equal(_A(150));
    newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

    await expect(eurocfLender.connect(anon).resolvePolicy(newPolicyEvt.args[1], _A(600))).to.be.revertedWith(
      accessControlMessage(anon.address, null, "RESOLVER_ROLE")
    );
    expect(await eurocfLender.currentDebt()).to.be.equal(_A(150));

    await expect(eurocfLender.connect(resolver).resolvePolicy(newPolicyEvt.args[1], _A(600)))
      .to.emit(eurocfLender, "DebtChanged")
      .withArgs(-_A(375)); // -375 = 150 - policyPayout(in USD = 571.824750) / 1.08919

    await expect(eurocfLender.connect(owner).repayDebt(_A(100))).to.be.revertedWith(
      "EuroCashFlowLender: debt must be greater than 0"
    );

    await expect(eurocfLender.connect(anon).cashOutPayouts(_A(500), cust.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "CUSTOMER_ROLE")
    );
    await expect(eurocfLender.connect(cust).cashOutPayouts(_A(500), cust.address)).to.be.revertedWith(
      "EuroCashFlowLender: amount must be less than debt"
    );
    await expect(eurocfLender.connect(cust).cashOutPayouts(_A(375), cust.address))
      .to.emit(eurocfLender, "CashOutPayout")
      .withArgs(cust.address, _A(375), _A("408.446250")); // 408.44 = 375 * 1.08919
  });

  it("Checks policy expires OK", async () => {
    const { rm, pool, eurocfLender, currency, assetOracle } = await helpers.loadFixture(deployPoolFixture);

    let policyParams = await defaultPolicyParams({ rmAddress: rm.address, payout: _A(800), premium: _A(200) });
    const signature = await makeSignedQuote(signer, policyParams);

    const now = await helpers.time.latest();
    await addRound(assetOracle, 108919000, now - HOUR * 2, now - HALF_HOUR);
    let [, assetPrice] = await assetOracle.latestRoundData();
    assetPrice = toCurrencyDecimals(assetPrice);

    await currency.connect(owner).transfer(eurocfLender.address, _A(1000));
    let tx = await newPolicy(eurocfLender, creator, policyParams, cust, signature);
    let receipt = await tx.wait();
    expect(await eurocfLender.currentDebt()).to.be.equal(_A(200));
    let newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    //
    await helpers.time.increaseTo(newPolicyEvt.args[1].expiration + 500);
    // Expire the policy
    await expect(pool.expirePolicy(newPolicyEvt.args[1])).not.to.emit(eurocfLender, "DebtChanged");
    expect(await eurocfLender.currentDebt()).to.be.equal(_A(200));
  });

  it("EuroCashFlowLender old asset price", async () => {
    const { rm, eurocfLender, assetOracle } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address, payout: _A(500), premium: _A(80) });
    const signature = await makeSignedQuote(signer, policyParams);

    const now = await helpers.time.latest();
    await addRound(assetOracle, 108919000, now - HOUR * 2, now - 3 * HOUR);
    let [, assetPrice] = await assetOracle.latestRoundData();
    assetPrice = toCurrencyDecimals(assetPrice);

    await expect(newPolicy(eurocfLender, creator, policyParams, cust, signature)).to.be.revertedWith(
      "Price is older than tolerable"
    );
  });

  it("Test only the owner can withdraw the funds", async () => {
    const { rm, pool, eurocfLender, currency, assetOracle } = await helpers.loadFixture(deployPoolFixture);

    let policyParams = await defaultPolicyParams({ rmAddress: rm.address, payout: _A(800), premium: _A(200) });
    const signature = await makeSignedQuote(signer, policyParams);

    const now = await helpers.time.latest();
    await addRound(assetOracle, 108919000, now - HOUR * 2, now - HALF_HOUR);
    let [, assetPrice] = await assetOracle.latestRoundData();
    assetPrice = toCurrencyDecimals(assetPrice);

    await currency.connect(owner).transfer(eurocfLender.address, _A(1000));
    let tx = await newPolicy(eurocfLender, creator, policyParams, cust, signature);
    let receipt = await tx.wait();
    expect(await eurocfLender.currentDebt()).to.be.equal(_A(200));
    let newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

    expect(await currency.balanceOf(eurocfLender.address)).to.be.equal(_A("782.162")); // 1000 - (200 * 1.08919) = 782.162

    // Can't withdraw to zero address
    await expect(eurocfLender.connect(owner).withdraw(_A(200), ethers.constants.AddressZero)).to.be.revertedWith(
      "EuroCashFlowLender: destination cannot be the zero address"
    );
    // Try changing the customer with anon
    await expect(eurocfLender.connect(anon).withdraw(_A(200), anon.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "OWNER_ROLE")
    );
    await expect(eurocfLender.connect(owner).withdraw(_A(300), anon.address))
      .to.emit(eurocfLender, "Withdrawal")
      .withArgs(anon.address, _A(300)); //  300 * 1.08919 = 326.757
    expect(await currency.balanceOf(anon.address)).to.be.equal(_A(300));

    expect(await currency.balanceOf(eurocfLender.address)).to.be.equal(_A("782.162") - _A(300));

    await expect(eurocfLender.connect(owner).withdraw(ethers.constants.MaxUint256, anon.address))
      .to.emit(eurocfLender, "Withdrawal")
      .withArgs(anon.address, _A("782.162") - _A(300));
    expect(await currency.balanceOf(eurocfLender.address)).to.be.equal(_A(0));
    // When no more funds, withdraw doesn't fails, just doesn't do anything
    await expect(eurocfLender.connect(owner).withdraw(ethers.constants.MaxUint256, anon.address)).not.to.emit(
      eurocfLender,
      "Withdrawal"
    );
  });

  it("Resolve policy with changes in asset price", async () => {
    const { pool, rm, eurocfLender, currency, assetOracle } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address, payout: _A(100), premium: _A(20) });
    const signature = await makeSignedQuote(signer, policyParams);

    const now = await helpers.time.latest();
    await addRound(assetOracle, 110000000, now - HOUR * 2, now - HALF_HOUR);
    let [, assetPrice] = await assetOracle.latestRoundData();
    assetPrice = toCurrencyDecimals(assetPrice);

    await currency.connect(owner).transfer(eurocfLender.address, _A(500));
    const tx = await newPolicy(eurocfLender, creator, policyParams, cust, signature);
    const receipt = await tx.wait();
    expect(await currency.balanceOf(eurocfLender.address)).to.be.equal(_A(500) - _A(20) * assetPrice);
    expect(await eurocfLender.currentDebt()).to.be.equal(_A(20));

    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

    expect(newPolicyEvt.args.policy.payout).to.be.equal(_A(100 * 1.1 * 1.05));

    const maxPayout = newPolicyEvt.args.policy.payout;
    const policyId = newPolicyEvt.args[1].id;
    expect(await pool.ownerOf(policyId)).to.be.equal(eurocfLender.address);

    // Change asset price
    await addRound(assetOracle, 120000000, now - HOUR * 2, now - HALF_HOUR);
    [, assetPrice] = await assetOracle.latestRoundData();
    assetPrice = toCurrencyDecimals(assetPrice);

    // Two DebtChanged events triggered
    await expect(eurocfLender.connect(resolver).resolvePolicy(newPolicyEvt.args[1], _A(100)))
      .to.emit(eurocfLender, "DebtChanged")
      .withArgs(_A(20).sub(maxPayout / 1.2))
      .to.emit(eurocfLender, "DebtChanged")
      .withArgs(_A(20 - 100));
    expect(await eurocfLender.currentDebt()).to.be.equal(_A(20) - _A(100)); // 20 previous debt - 100 payout
  });

  it("Only policy pool can call onPayoutReceived", async () => {
    const { pool, rm, eurocfLender, currency, assetOracle } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address, payout: _A(100), premium: _A(20) });
    const signature = await makeSignedQuote(signer, policyParams);

    const now = await helpers.time.latest();
    await addRound(assetOracle, 110000000, now - HOUR * 2, now - HALF_HOUR);
    let [, assetPrice] = await assetOracle.latestRoundData();
    assetPrice = toCurrencyDecimals(assetPrice);

    await currency.connect(owner).transfer(eurocfLender.address, _A(500));
    const tx = await newPolicy(eurocfLender, creator, policyParams, cust, signature);
    const receipt = await tx.wait();
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const policyId = newPolicyEvt.args[1].id;

    await expect(
      eurocfLender.connect(owner).onPayoutReceived(owner.address, pool.address, policyId, _A(800))
    ).to.be.revertedWith("Only the PolicyPool should call this method");
  });
});
