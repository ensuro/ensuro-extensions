const { expect } = require("chai");
const {
  _W,
  amountFunction,
  getTransactionEvent,
  accessControlMessage,
  makeQuoteMessage,
  makeSignedQuote,
  makeBucketQuoteMessage,
} = require("@ensuro/core/js/utils");
const {
  initCurrency,
  deployPool,
  deployPremiumsAccount,
  addRiskModule,
  addEToken,
} = require("@ensuro/core/js/test-utils");
const {
  newPolicy,
  defaultPolicyParams,
  makeBatchParams,
  defaultBucketPolicyParams,
  newBucketPolicy,
} = require("./test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { ethers } = hre;
const { MaxUint256, ZeroAddress } = ethers;

describe("ERC4626CashFlowLender contract tests", function () {
  let _A;
  let anon, borrower, changeRm, creator, cust, guardian, lp, lp2, owner, resolver, signer;

  beforeEach(async () => {
    [, lp, lp2, cust, signer, resolver, creator, anon, owner, guardian, changeRm, borrower] = await ethers.getSigners();

    _A = amountFunction(6);
  });

  async function deployPoolFixture(creationIsOpen) {
    creationIsOpen = creationIsOpen === undefined ? true : creationIsOpen;
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(50000) },
      [lp, lp2, cust, owner],
      [_A(10000), _A(10000), _A(2000), _A(1000)]
    );
    const currencyAddr = await ethers.resolveAddress(currency);

    const pool = await deployPool({
      currency: currency,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
    });
    pool._A = _A;

    const accessManager = await ethers.getContractAt("AccessManager", await pool.access());

    // Setup the liquidity sources
    const etk = await addEToken(pool, {});
    const premiumsAccount = await deployPremiumsAccount(pool, { srEtk: etk });

    // Provide some liquidity
    await currency.connect(lp).approve(pool, _A(5000));
    await pool.connect(lp).deposit(etk, _A(5000));

    // Customer approval
    await currency.connect(cust).approve(pool, _A(500));

    // Setup the risk module
    const SignedQuoteRiskModule = await ethers.getContractFactory("SignedQuoteRiskModule");
    const rm = await addRiskModule(pool, premiumsAccount, SignedQuoteRiskModule, {
      ensuroFee: 0.03,
      extraConstructorArgs: [creationIsOpen],
    });
    const rmAddr = await ethers.resolveAddress(rm);

    await accessManager.grantComponentRole(rm, await rm.PRICER_ROLE(), signer);
    const ERC4626CashFlowLender = await ethers.getContractFactory("ERC4626CashFlowLender");
    const erc4626cfl = await hre.upgrades.deployProxy(ERC4626CashFlowLender, ["CFL", "ensCFL", rmAddr, currencyAddr], {
      kind: "uups",
    });

    await accessManager.grantComponentRole(rm, await rm.POLICY_CREATOR_ROLE(), erc4626cfl);
    await accessManager.grantComponentRole(rm, await rm.RESOLVER_ROLE(), erc4626cfl);
    await accessManager.grantComponentRole(rm, await rm.PRICER_ROLE(), erc4626cfl);
    await erc4626cfl.grantRole(await erc4626cfl.LP_ROLE(), lp);
    await erc4626cfl.grantRole(await erc4626cfl.CUSTOMER_ROLE(), cust);
    await erc4626cfl.grantRole(await erc4626cfl.BORROWER_ROLE(), borrower);
    await erc4626cfl.grantRole(await erc4626cfl.CHANGE_RM_ROLE(), changeRm);
    await erc4626cfl.grantRole(await erc4626cfl.RESOLVER_ROLE(), resolver);
    await erc4626cfl.grantRole(await erc4626cfl.POLICY_CREATOR_ROLE(), creator);
    await erc4626cfl.grantRole(await erc4626cfl.REPLACER_ROLE(), creator);
    await erc4626cfl.grantRole(await erc4626cfl.GUARDIAN_ROLE(), guardian);

    return {
      etk,
      premiumsAccount,
      rm,
      rmAddr,
      pool,
      accessManager,
      currency,
      currencyAddr,
      erc4626cfl,
      ERC4626CashFlowLender,
    };
  }

  async function deployBucketRmFixture(bucketId = 0) {
    const { pool, premiumsAccount, erc4626cfl, accessManager, ...others } =
      await helpers.loadFixture(deployPoolFixture);
    // Setup the bucket risk module
    const SignedBucketRiskModule = await hre.ethers.getContractFactory("SignedBucketRiskModule");
    const bucketRm = await addRiskModule(pool, premiumsAccount, SignedBucketRiskModule, {
      collRatio: "1.0",
    });

    if (bucketId != 0 && bucketId != MaxUint256) {
      const bucket = bucketParameters({});
      await bucketRm.setBucketParams(1234, bucket.asParams());
    }

    await accessManager.grantComponentRole(bucketRm, await bucketRm.PRICER_ROLE(), signer);

    await accessManager.grantComponentRole(bucketRm, await bucketRm.PRICER_ROLE(), erc4626cfl);
    await accessManager.grantComponentRole(bucketRm, await bucketRm.POLICY_CREATOR_ROLE(), erc4626cfl);
    await accessManager.grantComponentRole(bucketRm, await bucketRm.REPLACER_ROLE(), erc4626cfl);
    await accessManager.grantComponentRole(bucketRm, await bucketRm.RESOLVER_ROLE(), erc4626cfl);

    return { bucketRm, erc4626cfl, pool, accessManager, premiumsAccount, ...others };
  }

  it("ERC4626CashFlowLender init", async () => {
    const { rm, erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    expect(await erc4626cfl.riskModule()).to.equal(rm);
    expect(await erc4626cfl.asset()).to.equal(currency);
    expect(await erc4626cfl.totalAssets()).to.equal(0);
    expect(await erc4626cfl.name()).to.equal("CFL");
    expect(await erc4626cfl.symbol()).to.equal("ensCFL");
  });

  it("Should not allow address(0) for the RM and Asset", async () => {
    const { rmAddr, currencyAddr } = await helpers.loadFixture(deployPoolFixture);

    const ERC4626CashFlowLender = await ethers.getContractFactory("ERC4626CashFlowLender");
    await expect(
      hre.upgrades.deployProxy(ERC4626CashFlowLender, ["CFL", "ensCFL", ZeroAddress, currencyAddr], {
        kind: "uups",
      })
    ).to.be.revertedWith("ERC4626CashFlowLender: riskModule_ cannot be zero address");

    await expect(
      hre.upgrades.deployProxy(ERC4626CashFlowLender, ["CFL", "ensCFL", rmAddr, ZeroAddress], {
        kind: "uups",
      })
    ).to.be.revertedWith("ERC4626CashFlowLender: asset_ cannot be zero address");
  });

  it("Only CHANGE_RM_ROLE can change the RM", async () => {
    const { rm, pool, premiumsAccount, erc4626cfl } = await helpers.loadFixture(deployPoolFixture);

    const SignedQuoteRiskModule = await ethers.getContractFactory("SignedQuoteRiskModule");
    const newImpl = await SignedQuoteRiskModule.deploy(pool, premiumsAccount, false);

    expect(await erc4626cfl.riskModule()).to.equal(rm);

    await expect(erc4626cfl.connect(anon).setRiskModule(newImpl)).to.be.revertedWith(
      accessControlMessage(anon, null, "CHANGE_RM_ROLE")
    );
    await expect(erc4626cfl.connect(changeRm).setRiskModule(ZeroAddress)).to.be.revertedWith(
      "ERC4626CashFlowLender: riskModule_ cannot be zero address"
    );

    expect(await erc4626cfl.riskModule()).to.equal(rm);

    await expect(erc4626cfl.connect(changeRm).setRiskModule(newImpl))
      .to.emit(erc4626cfl, "RiskModuleChanged")
      .withArgs(newImpl);

    expect(await erc4626cfl.riskModule()).to.equal(newImpl);
  });

  it("Creates a policy paid by the ERC4626CashFlowLender", async () => {
    const { rm, pool, currency, erc4626cfl } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rm: rm, premium: _A(200) });
    const signature = await makeSignedQuote(signer, policyParams);

    await expect(newPolicy(erc4626cfl, creator, policyParams, cust, signature)).to.be.revertedWith(
      "ERC20: transfer amount exceeds balance" // No funds in erc4626cfl
    );
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(0));
    await currency.connect(cust).transfer(erc4626cfl, _A(1000));
    const tx = await newPolicy(erc4626cfl, creator, policyParams, cust, signature);
    const receipt = await tx.wait();
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(800)); // 200 spent on the premium
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200));

    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const policyId = newPolicyEvt.args[1].id;
    expect(await pool.ownerOf(policyId)).to.be.equal(erc4626cfl);

    await expect(erc4626cfl.connect(anon).resolvePolicy([...newPolicyEvt.args[1]], _A(800))).to.be.revertedWith(
      accessControlMessage(anon, null, "RESOLVER_ROLE")
    );

    await erc4626cfl.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], _A(800));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200) - _A(800)); // 200 prev debt - 800 payout
  });

  it("Rejects if called by unauthorized user - newPolicy", async () => {
    const { rm, erc4626cfl } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rm: rm, premium: _A(200) });
    const signature = await makeSignedQuote(signer, policyParams);

    await expect(newPolicy(erc4626cfl, anon, policyParams, cust, signature)).to.be.revertedWith(
      accessControlMessage(anon, null, "POLICY_CREATOR_ROLE")
    );
  });

  it("Address without LP_ROLE can't withdraw/redeem", async () => {
    const { rm, erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rm: rm, payout: _A(800), premium: _A(200) });
    const signature = await makeSignedQuote(signer, policyParams);

    await currency.connect(cust).transfer(erc4626cfl, _A(800));
    await newPolicy(erc4626cfl, creator, policyParams, cust, signature);

    await expect(erc4626cfl.connect(anon).withdraw(_A(800), owner, anon)).to.be.revertedWith(
      accessControlMessage(anon, null, "LP_ROLE")
    );

    await expect(erc4626cfl.connect(anon).redeem(_A(800), owner, anon)).to.be.revertedWith(
      accessControlMessage(anon, null, "LP_ROLE")
    );
  });

  it("Only GUARDIAN_ROLE can upgrade", async () => {
    const { pool, erc4626cfl, premiumsAccount } = await helpers.loadFixture(deployPoolFixture);

    // Setup the risk module
    const SignedQuoteRiskModule = await ethers.getContractFactory("SignedQuoteRiskModule");
    const newImpl = await SignedQuoteRiskModule.deploy(pool, premiumsAccount, false);

    await expect(erc4626cfl.connect(anon).upgradeTo(newImpl)).to.be.revertedWith(
      accessControlMessage(anon, null, "GUARDIAN_ROLE")
    );

    await erc4626cfl.connect(guardian).upgradeTo(newImpl);
  });

  it("Checks policy expires OK and withdraw", async () => {
    const { rm, pool, erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    let policyParams = await defaultPolicyParams({ rm: rm, payout: _A(800), premium: _A(200) });
    const signature = await makeSignedQuote(signer, policyParams);

    await currency.connect(lp).approve(erc4626cfl, _A(5000));
    await erc4626cfl.connect(lp).deposit(_A(1000), lp);
    let tx = await newPolicy(erc4626cfl, creator, policyParams, cust, signature);
    let receipt = await tx.wait();
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200));
    let newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    //
    await helpers.time.increaseTo(newPolicyEvt.args[1].expiration + 500n);
    // Expire the policy
    await expect(pool.expirePolicy([...newPolicyEvt.args[1]])).not.to.emit(erc4626cfl, "DebtChanged");
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(800));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));

    // try to withdraw the funds
    await expect(erc4626cfl.connect(lp).withdraw(_A(1000), anon, lp)).to.be.revertedWith(
      "ERC4626: withdraw more than max"
    );
    await erc4626cfl.connect(lp).withdraw(_A(100), anon, lp);

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200)); // dont change
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(700)); // 800 prev - 100 withdraw
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(900)); // 1000 prev - 100 withdraw

    const lp2before = await currency.balanceOf(lp2);

    await expect(erc4626cfl.connect(lp2).repayDebt(_A(1000))).to.be.revertedWith("ERC20: insufficient allowance");
    await currency.connect(lp2).approve(erc4626cfl, _A(1000));

    // Repay partial debt
    await expect(erc4626cfl.connect(lp2).repayDebt(_A(50)))
      .to.emit(erc4626cfl, "DebtChanged")
      .withArgs(_A(150))
      .to.emit(currency, "Transfer")
      .withArgs(lp2, erc4626cfl, _A(50))
      .to.emit(erc4626cfl, "RepayDebt")
      .withArgs(lp2, _A(50), _A(200), _A(150));

    // Repay all debt
    await expect(erc4626cfl.connect(lp2).repayDebt(MaxUint256))
      .to.emit(erc4626cfl, "DebtChanged")
      .withArgs(_A(0))
      .to.emit(currency, "Transfer")
      .withArgs(lp2, erc4626cfl, _A(150))
      .to.emit(erc4626cfl, "RepayDebt")
      .withArgs(lp2, _A(150), _A(150), _A(0));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(lp2before - (await currency.balanceOf(lp2))).to.equal(_A(200));

    // Repay exceeds & debt becomes negative
    await expect(erc4626cfl.connect(lp2).repayDebt(_A(300)))
      .to.emit(erc4626cfl, "DebtChanged")
      .withArgs(_A(-300))
      .to.emit(currency, "Transfer")
      .withArgs(lp2, erc4626cfl, _A(300))
      .to.emit(erc4626cfl, "RepayDebt")
      .withArgs(lp2, _A(300), 0, _A(-300));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(-300));
    expect(lp2before - (await currency.balanceOf(lp2))).to.equal(_A(500));

    // Create a new policy after the last repay exceeding
    let newPolicyParams = await defaultPolicyParams({
      rm: rm,
      payout: _A(900),
      premium: _A(300),
      policyData: "0xa13fbfc7550fb24fb12960f14a126dc800fc35ad6aefe11c7d8a87d4f874744c",
    });
    const newSignature = await makeSignedQuote(signer, newPolicyParams);

    let newTx = await newPolicy(erc4626cfl, creator, newPolicyParams, cust, newSignature);
    let newReceipt = await newTx.wait();

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    newPolicyEvt = getTransactionEvent(pool.interface, newReceipt, "NewPolicy");

    await helpers.time.increaseTo(newPolicyEvt.args[1].expiration + 500n);
    await expect(pool.expirePolicy([...newPolicyEvt.args[1]])).not.to.emit(erc4626cfl, "DebtChanged");
    // Debt in 0 after new policy
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
  });

  it("Handles negative debt after resolution and customer payment", async () => {
    const { rm, pool, erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    let policyParams = await defaultPolicyParams({ rm: rm, payout: _A(100), premium: _A(10), lossProb: _W(0.05) });

    const signature = await makeSignedQuote(signer, policyParams);

    await currency.connect(lp).approve(erc4626cfl, _A(5000));
    await erc4626cfl.connect(lp).deposit(_A(1000), lp);

    let tx = await newPolicy(erc4626cfl, creator, policyParams, cust, signature);
    let receipt = await tx.wait();
    // Settlement Sent to the customer, client pays 10. (offchain)
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(10));

    let newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

    // Resolve Policy, debt now is negative: -90
    await erc4626cfl.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], _A(100));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(-90));
    await currency.connect(lp2).approve(erc4626cfl, _A(1000));

    // Repay with MaxUint256 with negative debt & Emit RepayDebt event
    await expect(erc4626cfl.connect(lp2).repayDebt(MaxUint256))
      .to.emit(erc4626cfl, "DebtChanged")
      .withArgs(_A(-90))
      .to.emit(erc4626cfl, "RepayDebt")
      .withArgs(lp2, 0, _A(-90), _A(-90));

    // Repay of 10 updating debt to -100 & Emit RepayDebt event
    await expect(erc4626cfl.connect(lp2).repayDebt(_A(10)))
      .to.emit(erc4626cfl, "DebtChanged")
      .withArgs(_A(-100))
      .to.emit(erc4626cfl, "RepayDebt")
      .withArgs(lp2, _A(10), _A(-90), _A(-100));

    // Client Cashout 100 - Pay sent to client (offchain)
    await expect(erc4626cfl.connect(cust).cashOutPayouts(_A(100), cust))
      .to.emit(erc4626cfl, "CashOutPayout")
      .withArgs(cust, _A(100));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
  });

  it("Address without LP_ROLE can't deposit/mint", async () => {
    const { erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    await currency.connect(cust).transfer(erc4626cfl, _A(800));
    await expect(erc4626cfl.connect(anon).deposit(_A(800), anon)).to.be.revertedWith(
      accessControlMessage(anon, null, "LP_ROLE")
    );

    await expect(erc4626cfl.connect(anon).mint(_A(800), erc4626cfl)).to.be.revertedWith(
      accessControlMessage(anon, null, "LP_ROLE")
    );
  });

  it("Customer cashout", async () => {
    const { rm, pool, currency, erc4626cfl } = await helpers.loadFixture(deployPoolFixture);
    let policyParams = await defaultPolicyParams({ rm: rm, premium: _A(200) });
    let signature = await makeSignedQuote(signer, policyParams);

    await currency.connect(owner).transfer(erc4626cfl, _A(1000));
    let tx = await newPolicy(erc4626cfl, creator, policyParams, cust, signature);
    let receipt = await tx.wait();
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(800));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));

    let newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    await expect(erc4626cfl.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], _A(150)))
      .to.emit(erc4626cfl, "DebtChanged")
      .withArgs(_A(50));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(50));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(950));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));
    expect(await currency.balanceOf(cust)).to.be.equal(_A(2000)); // 2000 initial

    // 2nd Policy
    policyParams = await defaultPolicyParams({
      rm: rm,
      premium: _A(100),
      payout: _A(500),
      policyData: "0x2cbef6744ebcff4969e06c41631a1d0aa71366c4fd997e9ff5a59b8efa9b9032",
    });
    signature = await makeSignedQuote(signer, policyParams);

    tx = await newPolicy(erc4626cfl, creator, policyParams, cust, signature);
    receipt = await tx.wait();
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(150));
    newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

    await expect(erc4626cfl.connect(anon).resolvePolicyFullPayout([...newPolicyEvt.args[1]], true)).to.be.revertedWith(
      accessControlMessage(anon, null, "RESOLVER_ROLE")
    );

    await expect(erc4626cfl.connect(resolver).resolvePolicyFullPayout([...newPolicyEvt.args[1]], true))
      .to.emit(erc4626cfl, "DebtChanged")
      .withArgs(_A(150 - 500)); // 150 prev debt - 500 payout = -350

    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(1350));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(-350));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));

    await expect(erc4626cfl.connect(anon).cashOutPayouts(_A(500), cust)).to.be.revertedWith(
      accessControlMessage(anon, null, "CUSTOMER_ROLE")
    );
    await expect(erc4626cfl.connect(cust).cashOutPayouts(_A(351), cust)).to.be.revertedWith(
      "ERC4626CashFlowLender: amount must be less than debt"
    );
    await expect(erc4626cfl.connect(cust).cashOutPayouts(_A(350), cust))
      .to.emit(erc4626cfl, "CashOutPayout")
      .withArgs(cust, _A(350));

    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(1000));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));
  });

  it("Create and resolve policies in batch paid by the ERC4626CashFlowLender", async () => {
    const { rm, pool, currency, erc4626cfl } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = [
      await defaultPolicyParams({ rm: rm, premium: _A(200), payout: _A(900) }),
      await defaultPolicyParams({
        rm: rm,
        premium: _A(300),
        payout: _A(950),
        policyData: "0xb494869573b0a0ce9caac5394e1d0d255d146ec7e2d30d643a4e1d78980f3236",
      }),
      await defaultPolicyParams({
        rm: rm,
        premium: _A(100),
        payout: _A(800),
        policyData: "0xb494869573b0a0ce9caac5394e1d0d255d146ec7e2d30d643a4e1d78980f3237",
      }),
    ];
    const quoteMessages = policyParams.map(makeQuoteMessage);
    const signatures = await Promise.all(
      quoteMessages.map(async (qm) => ethers.Signature.from(await signer.signMessage(ethers.getBytes(qm))))
    );

    await expect(
      erc4626cfl.connect(anon).newPoliciesInBatch(...makeBatchParams(policyParams, signatures))
    ).to.be.revertedWith(accessControlMessage(anon, null, "POLICY_CREATOR_ROLE"));

    await expect(
      erc4626cfl.connect(creator).newPoliciesInBatch(...makeBatchParams(policyParams, signatures))
    ).to.be.revertedWith("ERC20: transfer amount exceeds balance");

    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(0));

    // Transfer some money, not enough to cover all the premiums
    await currency.connect(owner).transfer(erc4626cfl, _A(300));

    await expect(
      erc4626cfl.connect(creator).newPoliciesInBatch(...makeBatchParams(policyParams, signatures))
    ).to.be.revertedWith("ERC20: transfer amount exceeds balance");

    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(300));

    await currency.connect(owner).transfer(erc4626cfl, _A(500));

    const tx = await erc4626cfl.connect(creator).newPoliciesInBatch(...makeBatchParams(policyParams, signatures));
    const receipt = await tx.wait();
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(200)); // 600 spent on the premium
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(600));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(800));
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const policyId = newPolicyEvt.args[1].id;
    expect(await pool.ownerOf(policyId)).to.be.equal(erc4626cfl);

    // for each log in the transaction receipt
    const newPolicyEvts = [];
    for (const log of receipt.logs) {
      let parsedLog;
      try {
        parsedLog = pool.interface.parseLog(log);
      } catch (error) {
        continue;
      }
      if (parsedLog?.name == "NewPolicy") {
        newPolicyEvts.push(parsedLog);
      }
    }

    expect(newPolicyEvts.length).to.be.equal(3);
    expect(await pool.ownerOf(newPolicyEvts[1].args[1].id)).to.be.equal(erc4626cfl);
    expect(await pool.ownerOf(newPolicyEvts[2].args[1].id)).to.be.equal(erc4626cfl);

    await expect(
      erc4626cfl
        .connect(anon)
        .resolvePoliciesInBatch(
          [[...newPolicyEvts[0].args[1]], [...newPolicyEvts[1].args[1]], [...newPolicyEvts[2].args[1]]],
          [_A(300), _A(300), _A(300)]
        )
    ).to.be.revertedWith(accessControlMessage(anon, null, "RESOLVER_ROLE"));

    const resolveTx = await erc4626cfl
      .connect(resolver)
      .resolvePoliciesInBatch(
        [[...newPolicyEvts[0].args[1]], [...newPolicyEvts[1].args[1]], [...newPolicyEvts[2].args[1]]],
        [_A(300), _A(300), _A(300)]
      );
    const resolveReceipt = await resolveTx.wait();

    // for each log in the transaction receipt
    const resolvePolicyEvts = [];
    for (const log of resolveReceipt.logs) {
      let parsedLog;
      try {
        parsedLog = pool.interface.parseLog(log);
      } catch (error) {
        continue;
      }
      if (parsedLog?.name == "PolicyResolved") {
        resolvePolicyEvts.push(parsedLog);
      }
    }
    expect(resolvePolicyEvts.length).to.be.equal(3);

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(-300)); // 600 prev debt - (300 payout * 3 )
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(1100));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(800));

    await currency.connect(lp).approve(erc4626cfl, _A(300));
    await erc4626cfl.connect(lp).deposit(_A(300), lp);

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(-300)); // dont change
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(1400)); // 1100 prev + 300 deposit
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1100));
    expect(await erc4626cfl.convertToAssets(_A(1100))).not.to.be.equal(_A(1100));
  });

  it("Only LP_ROLE can deposit/mint", async () => {
    const { erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    await expect(erc4626cfl.connect(anon).deposit(_A(800), anon)).to.be.revertedWith(
      accessControlMessage(anon, null, "LP_ROLE")
    );

    await expect(erc4626cfl.connect(anon).mint(_A(800), owner)).to.be.revertedWith(
      accessControlMessage(anon, null, "LP_ROLE")
    );

    expect(await currency.balanceOf(lp)).to.be.equal(_A(5000));

    await currency.connect(lp).approve(erc4626cfl, _A(5000));
    await erc4626cfl.connect(lp).deposit(_A(800), lp);

    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(800));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(800));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(lp)).to.be.equal(_A(4200));

    expect(await erc4626cfl.convertToAssets(_A(800))).to.be.equal(_A(800));
    await erc4626cfl.connect(lp).mint(_A(300), erc4626cfl);

    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(1100));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1100));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(lp)).to.be.equal(_A(3900));
  });

  it("Custom test case", async () => {
    const { rm, pool, currency, erc4626cfl } = await helpers.loadFixture(deployPoolFixture);
    let policyParams = await defaultPolicyParams({ rm: rm, premium: _A(40), payout: _A(100) });
    let signature = await makeSignedQuote(signer, policyParams);

    await currency.connect(lp).approve(erc4626cfl, _A(1000));
    await erc4626cfl.connect(lp).deposit(_A(100), lp);
    const tx = await newPolicy(erc4626cfl, creator, policyParams, cust, signature);
    const receipt = await tx.wait();

    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const policyId = newPolicyEvt.args[1].id;
    expect(await pool.ownerOf(policyId)).to.be.equal(erc4626cfl);

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(40));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(60));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(100));

    // Try to withdraw the funds
    await expect(erc4626cfl.connect(lp).withdraw(_A(100), anon, lp)).to.be.revertedWith(
      "ERC4626: withdraw more than max"
    );
    await expect(erc4626cfl.connect(lp).redeem(_A(100), anon, lp)).to.be.revertedWith("ERC4626: redeem more than max");

    await erc4626cfl.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], _A(80));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(40) - _A(80)); // 40 prev debt - 80 payout = -40
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(140));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(100));
  });

  it("Only deposit and withdraw", async () => {
    const { erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    await currency.connect(lp).approve(erc4626cfl, _A(5000));
    await erc4626cfl.connect(lp).deposit(_A(1000), lp);

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(1000));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));
    expect(await currency.balanceOf(anon)).to.be.equal(_A(0));

    await erc4626cfl.connect(lp).withdraw(_A(100), anon, lp);

    expect(await currency.balanceOf(anon)).to.be.equal(_A(100));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(900));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(900));

    // lp deposit shares to anon
    await erc4626cfl.connect(lp).deposit(_A(200), anon);
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(1100));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1100));
    expect(await currency.balanceOf(anon)).to.be.equal(_A(100));

    // can't withdraw because he doenst have LP_ROLE
    await expect(erc4626cfl.connect(anon).withdraw(_A(200), lp, anon)).to.be.revertedWith(
      accessControlMessage(anon, null, "LP_ROLE")
    );
    // give permission to anon
    await erc4626cfl.grantRole(await erc4626cfl.LP_ROLE(), anon);
    // try to withdraw more than he has
    await expect(erc4626cfl.connect(anon).withdraw(_A(300), lp, anon)).to.be.revertedWith(
      "ERC4626: withdraw more than max"
    );

    // now he can withdraw
    await erc4626cfl.connect(anon).withdraw(_A(200), anon, anon);

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(900));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(900));
    expect(await currency.balanceOf(anon)).to.be.equal(_A(300));
  });

  it("New RM must belong to the same pool", async () => {
    const { rm, erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    const otherPool = await deployPool({
      currency: currency,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1", // Other Random address
    });
    otherPool._A = _A;

    const premiumsAccount = await deployPremiumsAccount(otherPool, {}, false);

    const SignedQuoteRiskModule = await ethers.getContractFactory("SignedQuoteRiskModule");
    const newImpl = await SignedQuoteRiskModule.deploy(otherPool, premiumsAccount, false);

    expect(await erc4626cfl.riskModule()).to.equal(rm);

    await expect(erc4626cfl.connect(changeRm).setRiskModule(newImpl)).to.be.revertedWith(
      "ERC4626CashFlowLender: new riskModule must belong to the same pool"
    );

    expect(await erc4626cfl.riskModule()).to.equal(rm); // dont change
  });

  it("Only ERC4626 maxWithdraw", async () => {
    const { erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    await currency.connect(lp).approve(erc4626cfl, _A(5000));
    await erc4626cfl.connect(lp).deposit(_A(1000), lp);

    expect(await erc4626cfl.maxWithdraw(lp)).to.be.equal(_A(1000));
    expect(await erc4626cfl.maxWithdraw(cust)).to.be.equal(_A(0));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(1000));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));

    await currency.connect(cust).transfer(erc4626cfl, _A(1000));

    expect(await erc4626cfl.maxWithdraw(lp)).to.be.closeTo(_A(2000), _A(0.01));
    expect(await erc4626cfl.maxWithdraw(cust)).to.be.equal(_A(0));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(2000));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(2000));
  });

  it("Only ERC4626 maxRedeem", async () => {
    const { erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    await currency.connect(lp).approve(erc4626cfl, _A(5000));
    await erc4626cfl.connect(lp).deposit(_A(1000), lp);

    expect(await erc4626cfl.maxRedeem(lp)).to.be.equal(_A(1000));
    expect(await erc4626cfl.maxRedeem(cust)).to.be.equal(_A(0));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(1000));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));

    await currency.connect(cust).transfer(erc4626cfl, _A(1000));

    expect(await erc4626cfl.maxRedeem(lp)).to.be.equal(_A(1000));
    expect(await erc4626cfl.maxRedeem(cust)).to.be.equal(_A(0));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(2000));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(2000));
  });

  it("Two LPs with policies - maxWithdraw/maxRedeem - assets == shares ", async () => {
    const { rm, pool, erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    let policyParams = await defaultPolicyParams({ rm: rm, payout: _A(800), premium: _A(200) });
    const signature = await makeSignedQuote(signer, policyParams);

    await erc4626cfl.grantRole(await erc4626cfl.LP_ROLE(), lp2);

    await currency.connect(lp).approve(erc4626cfl, _A(5000));
    await currency.connect(lp2).approve(erc4626cfl, _A(5000));
    await erc4626cfl.connect(lp).deposit(_A(500), lp);
    await erc4626cfl.connect(lp2).deposit(_A(500), lp2);

    // Check maxWithdraw and maxRedeem
    expect(await erc4626cfl.maxWithdraw(lp)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxWithdraw(lp2)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(lp)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(lp2)).to.be.equal(_A(500));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(1000));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));

    // First policy, should increase the debt to 200 and decrease the balance
    let tx = await newPolicy(erc4626cfl, creator, policyParams, cust, signature);
    let receipt = await tx.wait();
    let newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(800));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));

    // same maxWithdraw and maxRedeem ( assets == shares )
    expect(await erc4626cfl.maxWithdraw(lp)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxWithdraw(lp2)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(lp)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(lp2)).to.be.equal(_A(500));

    await erc4626cfl.connect(lp).withdraw(_A(100), lp, lp);
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(700));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(900));

    expect(await erc4626cfl.maxWithdraw(lp)).to.be.equal(_A(400));
    expect(await erc4626cfl.maxWithdraw(lp2)).to.be.equal(_A(500));

    expect(await erc4626cfl.maxRedeem(lp)).to.be.equal(_A(400));
    expect(await erc4626cfl.maxRedeem(lp2)).to.be.equal(_A(500));

    await erc4626cfl.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], _A(800));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200) - _A(800)); // 200 prev debt - 800 payout = -600
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(1500));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(900));

    expect(await erc4626cfl.maxWithdraw(lp)).to.be.equal(_A(400));
    expect(await erc4626cfl.maxWithdraw(lp2)).to.be.equal(_A(500));

    await erc4626cfl.connect(lp).withdraw(_A(170), lp, lp);
    expect(await erc4626cfl.maxWithdraw(lp)).to.be.equal(_A(230));
    expect(await erc4626cfl.maxWithdraw(lp2)).to.be.equal(_A(500));

    expect(await erc4626cfl.maxRedeem(lp)).to.be.equal(_A(230));
    expect(await erc4626cfl.maxRedeem(lp2)).to.be.equal(_A(500));

    await erc4626cfl.connect(lp).withdraw(_A(230), lp, lp);
    expect(await erc4626cfl.maxWithdraw(lp)).to.be.equal(_A(0));
    expect(await erc4626cfl.maxWithdraw(lp2)).to.be.equal(_A(500));

    expect(await erc4626cfl.maxRedeem(lp)).to.be.equal(_A(0));
    expect(await erc4626cfl.maxRedeem(lp2)).to.be.equal(_A(500));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(-600));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(1100));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(500));

    await erc4626cfl.connect(lp2).withdraw(_A(500), lp2, lp2);
    expect(await erc4626cfl.maxWithdraw(lp2)).to.be.equal(_A(0));

    expect(await erc4626cfl.maxRedeem(lp2)).to.be.equal(_A(0));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(-600));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(600));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(0));
  });

  it("Two LPs without policies - maxWithdraw/maxRedeem - assets !== shares", async () => {
    const { erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    await erc4626cfl.grantRole(await erc4626cfl.LP_ROLE(), lp2);

    await currency.connect(lp).approve(erc4626cfl, _A(5000));
    await currency.connect(lp2).approve(erc4626cfl, _A(5000));
    await erc4626cfl.connect(lp).deposit(_A(500), lp);
    await erc4626cfl.connect(lp2).deposit(_A(500), lp2);

    // Check maxWithdraw and maxRedeem
    expect(await erc4626cfl.maxWithdraw(lp)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxWithdraw(lp2)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(lp)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(lp2)).to.be.equal(_A(500));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(1000));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));

    // "Free money" -> assets != shares
    await currency.connect(cust).transfer(erc4626cfl, _A(1000));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(2000));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(2000));

    // maxWithdraw increase to 1000
    expect(await erc4626cfl.maxWithdraw(lp)).to.be.closeTo(_A(1000), _A("0.01"));
    expect(await erc4626cfl.maxWithdraw(lp2)).to.be.closeTo(_A(1000), _A("0.01"));
    // maxRedeem is the same
    expect(await erc4626cfl.maxRedeem(lp)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(lp2)).to.be.equal(_A(500));

    // Withdraw almost all of the funds from lp
    await erc4626cfl.connect(lp).withdraw(_A("999.9999"), lp, lp);
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl)).to.be.closeTo(_A(1000), _A("0.0001"));
    expect(await erc4626cfl.totalAssets()).to.be.closeTo(_A(1000), _A("0.0001"));

    expect(await erc4626cfl.maxWithdraw(lp)).to.be.closeTo(_A(0), _A("0.01"));
    expect(await erc4626cfl.maxWithdraw(lp2)).to.be.closeTo(_A(1000), _A("0.01"));

    expect(await erc4626cfl.maxRedeem(lp)).to.be.closeTo(_A(0), _A("0.01"));
    expect(await erc4626cfl.maxRedeem(lp2)).to.be.equal(_A(500));

    expect(await currency.balanceOf(lp)).to.be.closeTo(_A("5499.9999"), _A("0.001")); // 5000 initial - 500 deposit + 1000 withdraw

    // try to withdraw more than he has
    await expect(erc4626cfl.connect(lp2).withdraw(_A(1100), lp2, lp2)).to.be.revertedWith(
      "ERC4626: withdraw more than max"
    );

    // try to redeem more than he has
    await expect(erc4626cfl.connect(lp2).redeem(_A(501), lp2, lp2)).to.be.revertedWith("ERC4626: redeem more than max");

    await erc4626cfl.connect(lp2).withdraw(_A(100), lp2, lp2);
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl)).to.be.closeTo(_A(900), _A("0.0001"));
    expect(await erc4626cfl.totalAssets()).to.be.closeTo(_A(900), _A("0.0001"));

    expect(await erc4626cfl.maxWithdraw(lp2)).to.be.closeTo(_A(900), _A("0.01"));
    expect(await erc4626cfl.maxRedeem(lp2)).to.be.equal(_A(450)); // withdraw 100 -> 50 assets and 50 shares

    expect(await currency.balanceOf(lp2)).to.be.equal(_A(9600)); // 10k initial - 500 deposit + 100 withdraw
  });

  it("Two LPs with policies - maxRedeem ", async () => {
    const { rm, pool, erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    let policyParams = await defaultPolicyParams({ rm: rm, payout: _A(800), premium: _A(200) });
    const signature = await makeSignedQuote(signer, policyParams);

    await erc4626cfl.grantRole(await erc4626cfl.LP_ROLE(), lp2);

    await currency.connect(lp).approve(erc4626cfl, _A(5000));
    await currency.connect(lp2).approve(erc4626cfl, _A(5000));
    await erc4626cfl.connect(lp).deposit(_A(500), lp);
    await erc4626cfl.connect(lp2).deposit(_A(500), lp2);

    expect(await erc4626cfl.maxRedeem(lp)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(lp2)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(anon)).to.be.equal(_A(0));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(1000));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));

    let tx = await newPolicy(erc4626cfl, creator, policyParams, cust, signature);
    let receipt = await tx.wait();
    let newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(800));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));

    expect(await erc4626cfl.maxRedeem(lp)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(lp2)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(anon)).to.be.equal(_A(0));

    await erc4626cfl.connect(lp).redeem(_A(100), anon, lp);
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(700));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(900));

    expect(await erc4626cfl.maxRedeem(lp)).to.be.equal(_A(400));
    expect(await erc4626cfl.maxRedeem(lp2)).to.be.equal(_A(500));

    await erc4626cfl.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], _A(800));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200) - _A(800)); // 200 prev debt - 800 payout = -600
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(1500));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(900));

    expect(await erc4626cfl.maxRedeem(lp)).to.be.equal(_A(400));
    expect(await erc4626cfl.maxRedeem(lp2)).to.be.equal(_A(500));

    await erc4626cfl.connect(lp).redeem(_A(170), anon, lp);
    expect(await erc4626cfl.maxRedeem(lp)).to.be.equal(_A(230));
    expect(await erc4626cfl.maxRedeem(lp2)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(anon)).to.be.equal(_A(0));

    await erc4626cfl.connect(lp).redeem(_A(230), anon, lp);
    expect(await erc4626cfl.maxRedeem(lp)).to.be.equal(_A(0));
    expect(await erc4626cfl.maxRedeem(lp2)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(anon)).to.be.equal(_A(0));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(-600));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(1100));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(500));

    await erc4626cfl.connect(lp2).redeem(_A(500), anon, lp2);
    expect(await erc4626cfl.maxRedeem(lp2)).to.be.equal(_A(0));
    expect(await erc4626cfl.maxRedeem(lp)).to.be.equal(_A(0));
    expect(await erc4626cfl.maxRedeem(anon)).to.be.equal(_A(0));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(-600));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(600));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(0));
  });

  it("Two LPs without policies - maxRedeem", async () => {
    const { erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    await erc4626cfl.grantRole(await erc4626cfl.LP_ROLE(), lp2);

    expect(await currency.balanceOf(lp)).to.be.equal(_A(5000));
    expect(await currency.balanceOf(lp2)).to.be.equal(_A(10000));

    await currency.connect(lp).approve(erc4626cfl, _A(5000));
    await currency.connect(lp2).approve(erc4626cfl, _A(5000));
    await erc4626cfl.connect(lp).deposit(_A(500), lp);
    await erc4626cfl.connect(lp2).deposit(_A(500), lp2);

    expect(await erc4626cfl.maxRedeem(lp)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(lp2)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(anon)).to.be.equal(_A(0));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(1000));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));

    await currency.connect(cust).transfer(erc4626cfl, _A(1000));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(2000));
    expect(await erc4626cfl.totalSupply()).to.be.equal(_A(1000));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(2000));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));

    expect(await erc4626cfl.maxRedeem(lp)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(lp2)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(anon)).to.be.equal(_A(0));

    expect(await erc4626cfl.maxWithdraw(lp)).to.be.closeTo(_A(1000), _A("0.001"));
    expect(await erc4626cfl.maxWithdraw(lp2)).to.be.closeTo(_A(1000), _A("0.001"));
    expect(await erc4626cfl.maxWithdraw(anon)).to.be.equal(_A(0));

    expect(await currency.balanceOf(lp)).to.be.equal(_A(4500)); // 5000 initial - 500 deposit

    await erc4626cfl.connect(lp).redeem(_A(500), lp, lp);
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl)).to.be.closeTo(_A(1000), _A("0.01"));
    expect(await erc4626cfl.totalAssets()).to.be.closeTo(_A(1000), _A("0.01"));

    expect(await erc4626cfl.maxRedeem(lp)).to.be.equal(_A(0));
    expect(await erc4626cfl.maxRedeem(lp2)).to.be.equal(_A(500));

    expect(await currency.balanceOf(lp)).to.be.closeTo(_A("5499.9999"), _A("0.001")); // 5000 initial - 500 deposit + 500 redeem + 499 shares

    // try to redeem more than he has
    await expect(erc4626cfl.connect(lp2).redeem(_A(501), lp2, lp2)).to.be.revertedWith("ERC4626: redeem more than max");

    await erc4626cfl.connect(lp2).redeem(_A(100), lp2, lp2);
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl)).to.be.closeTo(_A(800), _A("0.0001"));
    expect(await erc4626cfl.totalAssets()).to.be.closeTo(_A(800), _A("0.0001"));

    expect(await erc4626cfl.maxRedeem(lp)).to.be.closeTo(_A(0), _A("0.01"));
    expect(await erc4626cfl.maxRedeem(lp2)).to.be.equal(_A(400));

    expect(await currency.balanceOf(lp2)).to.be.equal(_A(9700)); // 10k initial - 500 deposit + 100 redeem + 100 shares
  });

  // Buckets id's
  [0, 1234].forEach((bucketId) => {
    it(`Can't create policies if no funds in erc4626cfl - bucketId === ${bucketId} - SignedBucketRiskModule`, async () => {
      const { bucketRm, erc4626cfl } = await deployBucketRmFixture(bucketId);
      const policyParams = await defaultBucketPolicyParams({ rm: bucketRm, premium: _A(200), bucketId });
      const signature = await makeSignedQuote(signer, policyParams, makeBucketQuoteMessage);

      await expect(newBucketPolicy(erc4626cfl, bucketRm, creator, policyParams, signature)).to.be.revertedWith(
        "ERC20: transfer amount exceeds balance" // No funds in erc4626cfl
      );
    });

    it(`Rejects if called by unauthorized user - bucketId === ${bucketId} - SignedBucketRiskModule`, async () => {
      const { bucketRm, erc4626cfl } = await deployBucketRmFixture(bucketId);
      const policyParams = await defaultBucketPolicyParams({ rm: bucketRm, premium: _A(200), bucketId });
      const signature = await makeSignedQuote(signer, policyParams, makeBucketQuoteMessage);

      await expect(newBucketPolicy(erc4626cfl, bucketRm, anon, policyParams, signature)).to.be.revertedWith(
        accessControlMessage(anon, null, "POLICY_CREATOR_ROLE")
      );
    });

    it(`Reject if called by unauthorized user - inBatch - bucketId === ${bucketId} - SignedBucketRiskModule`, async () => {
      const { bucketRm, erc4626cfl } = await deployBucketRmFixture(bucketId);
      const policyParams = [
        await defaultBucketPolicyParams({ rm: bucketRm, premium: _A(200), payout: _A(900), bucketId }),
        await defaultBucketPolicyParams({
          rm: bucketRm,
          premium: _A(300),
          payout: _A(950),
          policyData: "0xb494869573b0a0ce9caac5394e1d0d255d146ec7e2d30d643a4e1d78980f3236",
          bucketId,
        }),
        await defaultBucketPolicyParams({
          rm: bucketRm,
          premium: _A(100),
          payout: _A(800),
          policyData: "0xb494869573b0a0ce9caac5394e1d0d255d146ec7e2d30d643a4e1d78980f3237",
          bucketId,
        }),
      ];
      const quoteMessages = policyParams.map(makeBucketQuoteMessage);
      const signatures = await Promise.all(
        quoteMessages.map(async (qm) => hre.ethers.Signature.from(await signer.signMessage(hre.ethers.getBytes(qm))))
      );
      await expect(
        erc4626cfl.connect(anon).newPoliciesInBatchWithRm(...makeBatchParams(policyParams, signatures, bucketRm))
      ).to.be.revertedWith(accessControlMessage(anon, null, "POLICY_CREATOR_ROLE"));
    });

    it(`Only RESOLVER_ROLE can resolve policies - bucketId === ${bucketId} - SignedBucketRiskModule`, async () => {
      const { pool, currency, bucketRm, erc4626cfl } = await deployBucketRmFixture(bucketId);
      const policyParams = await defaultBucketPolicyParams({ rm: bucketRm, premium: _A(200), bucketId });
      const signature = await makeSignedQuote(signer, policyParams, makeBucketQuoteMessage);

      await currency.connect(cust).transfer(erc4626cfl, _A(1000));
      const tx = await newBucketPolicy(erc4626cfl, bucketRm, creator, policyParams, signature);
      const receipt = await tx.wait();
      await expect(tx).changeTokenBalance(currency, erc4626cfl, -policyParams.premium);
      expect(await erc4626cfl.currentDebt()).to.be.equal(policyParams.premium);

      const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
      const policyId = newPolicyEvt.args[1].id;
      expect(await pool.ownerOf(policyId)).to.be.equal(erc4626cfl);

      await expect(erc4626cfl.connect(anon).resolvePolicy([...newPolicyEvt.args[1]], _A(800))).to.be.revertedWith(
        accessControlMessage(anon, null, "RESOLVER_ROLE")
      );

      await erc4626cfl.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], _A(800));
      expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(1600));
      expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200) - _A(800)); // 200 prev debt - 800 payout = -600
    });

    it(`Creates policies in batch - bucketId === ${bucketId} - SignedBucketRiskModule`, async () => {
      const { pool, currency, bucketRm, erc4626cfl } = await deployBucketRmFixture(bucketId);
      const policyParams = [
        await defaultBucketPolicyParams({ rm: bucketRm, premium: _A(200), payout: _A(900), bucketId }),
        await defaultBucketPolicyParams({
          rm: bucketRm,
          premium: _A(300),
          payout: _A(950),
          policyData: "0xb494869573b0a0ce9caac5394e1d0d255d146ec7e2d30d643a4e1d78980f3236",
          bucketId,
        }),
        await defaultBucketPolicyParams({
          rm: bucketRm,
          premium: _A(100),
          payout: _A(800),
          policyData: "0xb494869573b0a0ce9caac5394e1d0d255d146ec7e2d30d643a4e1d78980f3237",
          bucketId,
        }),
      ];
      const quoteMessages = policyParams.map(makeBucketQuoteMessage);
      const signatures = await Promise.all(
        quoteMessages.map(async (qm) => hre.ethers.Signature.from(await signer.signMessage(hre.ethers.getBytes(qm))))
      );
      await currency.connect(owner).transfer(erc4626cfl, _A(800));

      const tx = await erc4626cfl
        .connect(creator)
        .newPoliciesInBatchWithRm(...makeBatchParams(policyParams, signatures, bucketRm));
      const receipt = await tx.wait();
      expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(200)); // 600 spent on the premium
      expect(await erc4626cfl.currentDebt()).to.be.equal(_A(600));
      expect(await erc4626cfl.totalAssets()).to.be.equal(_A(800));
      const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
      const policyId = newPolicyEvt.args[1].id;
      expect(await pool.ownerOf(policyId)).to.be.equal(erc4626cfl);

      // for each log in the transaction receipt
      const newPolicyEvts = [];
      for (const log of receipt.logs) {
        let parsedLog;
        try {
          parsedLog = pool.interface.parseLog(log);
        } catch (error) {
          continue;
        }
        if (parsedLog?.name == "NewPolicy") {
          newPolicyEvts.push(parsedLog);
        }
      }

      expect(newPolicyEvts.length).to.be.equal(3);
      expect(await pool.ownerOf(newPolicyEvts[1].args[1].id)).to.be.equal(erc4626cfl);
      expect(await pool.ownerOf(newPolicyEvts[2].args[1].id)).to.be.equal(erc4626cfl);
    });

    it(`Only REPLACER_ROLE can replace policies - bucketId === ${bucketId} - SignedBucketRiskModule`, async () => {
      const { pool, currency, bucketRm, erc4626cfl } = await deployBucketRmFixture(bucketId);
      const policyParams = await defaultBucketPolicyParams({
        rm: bucketRm,
        premium: _A(200),
        bucketId,
        payout: _A(800),
      });
      const signature = await makeSignedQuote(signer, policyParams, makeBucketQuoteMessage);

      await currency.connect(cust).transfer(erc4626cfl, _A(1000));
      const ogPolicyTx = await newBucketPolicy(erc4626cfl, bucketRm, creator, policyParams, signature);
      const receipt = await ogPolicyTx.wait();

      const policy = getTransactionEvent(pool.interface, receipt, "NewPolicy").args.policy;

      const replacementPolicyParams = await defaultBucketPolicyParams({
        rm: bucketRm,
        payout: _A("933"),
        premium: _A("300"),
        bucketId,
        lossProb: policyParams.lossProb,
        expiration: policy.expiration,
        validUntil: policyParams.validUntil,
      });
      const replacementPolicySignature = await makeSignedQuote(signer, replacementPolicyParams, makeBucketQuoteMessage);

      const replaceCallParams = [
        [...policy],
        replacementPolicyParams.payout,
        replacementPolicyParams.premium,
        replacementPolicyParams.lossProb,
        replacementPolicyParams.expiration,
        replacementPolicyParams.policyData,
        replacementPolicyParams.bucketId,
        replacementPolicySignature.r,
        replacementPolicySignature.yParityAndS,
        replacementPolicyParams.validUntil,
      ];

      await expect(erc4626cfl.connect(anon).replacePolicy(...replaceCallParams)).to.be.revertedWith(
        accessControlMessage(anon, null, "REPLACER_ROLE")
      );

      const tx = await erc4626cfl.connect(creator).replacePolicy(...replaceCallParams);
      await expect(tx).to.emit(pool, "PolicyReplaced");

      // Debt was increased
      await expect(tx).to.emit(erc4626cfl, "DebtChanged").withArgs(replacementPolicyParams.premium);
      await expect(tx).changeTokenBalance(
        currency,
        erc4626cfl,
        -_A("100") // replacement premium (300) - og premium (200)
      );
      expect(await erc4626cfl.currentDebt()).to.equal(replacementPolicyParams.premium);
    });
  });

  it("Can't create policies if no funds in erc4626cfl - bucketId === MaxUint256 - SignedQuoteRiskModule", async () => {
    const { rm, erc4626cfl } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultBucketPolicyParams({
      rm: rm,
      premium: _A(200),
      bucketId: MaxUint256,
    });
    const signature = await makeSignedQuote(signer, policyParams);

    await expect(newBucketPolicy(erc4626cfl, rm, creator, policyParams, signature)).to.be.revertedWith(
      "ERC20: transfer amount exceeds balance" // No funds in erc4626cfl
    );
  });

  it("Rejects if called by unauthorized user - bucketId === MaxUint256 - SignedQuoteRiskModule", async () => {
    const { rm, erc4626cfl } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultBucketPolicyParams({
      rm: rm,
      premium: _A(200),
      bucketId: MaxUint256,
    });
    const signature = await makeSignedQuote(signer, policyParams);

    await expect(newBucketPolicy(erc4626cfl, rm, anon, policyParams, signature)).to.be.revertedWith(
      accessControlMessage(anon, null, "POLICY_CREATOR_ROLE")
    );
  });

  it("With bucketID != MaxUint256 creates policy with SignedBucketRiskModule", async () => {
    const { pool, bucketRm, erc4626cfl, currency } = await helpers.loadFixture(deployBucketRmFixture);
    const policyParams = await defaultBucketPolicyParams({
      rm: bucketRm,
      premium: _A(200),
    });
    const signature = await makeSignedQuote(signer, policyParams, makeBucketQuoteMessage);

    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(0));
    await currency.connect(cust).transfer(erc4626cfl, _A(1000));
    const tx = await newBucketPolicy(erc4626cfl, bucketRm, creator, policyParams, signature);
    const receipt = await tx.wait();

    await expect(tx).changeTokenBalance(currency, erc4626cfl, -policyParams.premium);
    expect(await erc4626cfl.currentDebt()).to.be.equal(policyParams.premium);

    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const policyId = newPolicyEvt.args[1].id;
    expect(await pool.ownerOf(policyId)).to.be.equal(erc4626cfl);

    await erc4626cfl.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], _A(800));
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(1600));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200) - _A(800)); // 200 prev debt - 800 payout = -600
  });

  it("Create policies in batch with BucketId == MaxUint256 - SignedQuoteRiskModule ", async () => {
    const { rm, pool, currency, erc4626cfl } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = [
      await defaultBucketPolicyParams({
        rm: rm,
        premium: _A(200),
        payout: _A(900),
        bucketId: MaxUint256,
      }),
      await defaultBucketPolicyParams({
        rm: rm,
        premium: _A(300),
        payout: _A(950),
        bucketId: MaxUint256,
        policyData: "0xb494869573b0a0ce9caac5394e1d0d255d146ec7e2d30d643a4e1d78980f3236",
      }),
      await defaultBucketPolicyParams({
        rm: rm,
        premium: _A(100),
        payout: _A(800),
        bucketId: MaxUint256,
        policyData: "0xb494869573b0a0ce9caac5394e1d0d255d146ec7e2d30d643a4e1d78980f3237",
      }),
    ];
    const quoteMessages = policyParams.map(makeQuoteMessage);
    const signatures = await Promise.all(
      quoteMessages.map(async (qm) => hre.ethers.Signature.from(await signer.signMessage(hre.ethers.getBytes(qm))))
    );
    await currency.connect(owner).transfer(erc4626cfl, _A(800));

    const tx = await erc4626cfl
      .connect(creator)
      .newPoliciesInBatchWithRm(...makeBatchParams(policyParams, signatures, rm));
    const receipt = await tx.wait();
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(200)); // 600 spent on the premium
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(600));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(800));
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const policyId = newPolicyEvt.args[1].id;
    expect(await pool.ownerOf(policyId)).to.be.equal(erc4626cfl);

    // for each log in the transaction receipt
    const newPolicyEvts = [];
    for (const log of receipt.logs) {
      let parsedLog;
      try {
        parsedLog = pool.interface.parseLog(log);
      } catch (error) {
        continue;
      }
      if (parsedLog?.name == "NewPolicy") {
        newPolicyEvts.push(parsedLog);
      }
    }

    expect(newPolicyEvts.length).to.be.equal(3);
    expect(await pool.ownerOf(newPolicyEvts[1].args[1].id)).to.be.equal(erc4626cfl);
    expect(await pool.ownerOf(newPolicyEvts[2].args[1].id)).to.be.equal(erc4626cfl);
  });

  it("Only OWN_POLICY_CREATOR_ROLE can create policies on behalf of", async () => {
    const { bucketRm, erc4626cfl, pool, currency } = await helpers.loadFixture(deployBucketRmFixture);
    await currency.connect(cust).transfer(erc4626cfl, _A(1000));

    const policyParams = await defaultBucketPolicyParams({
      rm: bucketRm,
      premium: _A(200),
      bucketId: 0,
    });
    const signature = await makeSignedQuote(signer, policyParams, makeBucketQuoteMessage);
    const policyArgs = [
      bucketRm.target,
      policyParams.payout,
      policyParams.premium,
      policyParams.lossProb,
      policyParams.expiration,
      cust.address,
      policyParams.bucketId,
      policyParams.policyData,
      signature.r,
      signature.yParityAndS,
      policyParams.validUntil,
    ];

    // Anon can't call this method
    await expect(erc4626cfl.connect(anon).newPolicyOnBehalfOf(...policyArgs)).to.be.revertedWith(
      accessControlMessage(anon, null, "OWN_POLICY_CREATOR_ROLE")
    );

    // A user with OWN_POLICY_CREATOR_ROLE can
    await erc4626cfl.grantRole(await erc4626cfl.OWN_POLICY_CREATOR_ROLE(), creator);

    const tx = await erc4626cfl.connect(creator).newPolicyOnBehalfOf(...policyArgs);
    const newPolicyEvt = await getTransactionEvent(pool.interface, await tx.wait(), "NewPolicy");

    // The policy created is owned by the customer
    expect(await pool.ownerOf(newPolicyEvt.args.policy.id)).to.be.equal(cust.address);
    // The policy was paid by the CFL, not the customer or the creator
    await expect(tx).to.changeTokenBalance(currency, creator, 0);
    await expect(tx).to.changeTokenBalance(currency, cust, 0);
    await expect(tx).to.changeTokenBalance(currency, erc4626cfl, -policyParams.premium);
  });

  it("Only borrower role can borrow", async () => {
    const { currency, erc4626cfl } = await helpers.loadFixture(deployPoolFixture);

    await currency.connect(owner).transfer(erc4626cfl, _A(1000));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));

    await expect(erc4626cfl.connect(anon).borrow(_A(500), cust)).to.be.revertedWith(
      accessControlMessage(anon, null, "BORROWER_ROLE")
    );

    /* Increase the debt */
    await expect(erc4626cfl.connect(borrower).borrow(_A(500), borrower))
      .to.emit(erc4626cfl, "Borrow")
      .withArgs(borrower, _A(500));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(500));
    expect(await currency.balanceOf(borrower)).to.be.equal(_A(500));
  });

  it("Cannot borrow more than current balance", async () => {
    const { currency, erc4626cfl } = await helpers.loadFixture(deployPoolFixture);

    await currency.connect(owner).transfer(erc4626cfl, _A(1000));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));

    await expect(erc4626cfl.connect(borrower).borrow(_A(2000), borrower)).to.be.revertedWith(
      "ERC4626CashFlowLender: Not enough balance to borrow"
    );

    /* Increase the debt */
    await expect(erc4626cfl.connect(borrower).borrow(_A(500), borrower))
      .to.emit(erc4626cfl, "Borrow")
      .withArgs(borrower, _A(500));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(500));
    expect(await currency.balanceOf(borrower)).to.be.equal(_A(500));
  });

  it("Creates a policy paid by the ERC4626CashFlowLender and transfers it to another CFL after migration", async () => {
    const { rm, pool, currency, erc4626cfl, ERC4626CashFlowLender } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rm: rm, premium: _A(200) });
    const signature = await makeSignedQuote(signer, policyParams);

    await currency.connect(lp).approve(erc4626cfl, _A(5000));
    await erc4626cfl.connect(lp).deposit(_A(1000), lp);
    const tx = await newPolicy(erc4626cfl, creator, policyParams, cust, signature);
    const receipt = await tx.wait();
    expect(await currency.balanceOf(erc4626cfl)).to.be.equal(_A(800)); // 200 spent on the premium
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200));

    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const policyId = newPolicyEvt.args[1].id;
    expect(await pool.ownerOf(policyId)).to.be.equal(erc4626cfl);

    const MigrateERC4626CFL = await hre.ethers.getContractFactory("MigrateERC4626CFL");
    const otherCFL = await hre.upgrades.deployProxy(
      ERC4626CashFlowLender,
      ["othCFL", "ensOtherCFL", await ethers.resolveAddress(rm), await ethers.resolveAddress(currency)],
      {
        kind: "uups",
      }
    );
    const migrationImpl = await MigrateERC4626CFL.deploy(otherCFL);
    await erc4626cfl.connect(guardian).upgradeTo(migrationImpl);
    // Bind erc4626cfl to the new ABI
    const migratedCFL = await ethers.getContractAt("MigrateERC4626CFL", await ethers.resolveAddress(erc4626cfl));

    await expect(migratedCFL.connect(anon).migratePolicies([policyId])).to.be.revertedWith(
      accessControlMessage(anon, null, "MIGRATE_NFTS_ROLE")
    );
    await erc4626cfl.grantRole(await migratedCFL.MIGRATE_NFTS_ROLE(), anon);
    await expect(migratedCFL.connect(anon).migratePolicies([policyId]))
      .to.emit(pool, "Transfer")
      .withArgs(erc4626cfl, otherCFL, policyId);

    await erc4626cfl.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], _A(800));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200)); // 200 prev debt
    expect(await otherCFL.currentDebt()).to.be.equal(-_A(800)); // 200 prev debt - 800 payout
  });
});

function bucketParameters({ moc, jrCollRatio, collRatio, ensuroPpFee, ensuroCocFee, jrRoc, srRoc }) {
  return {
    moc: moc || _W("1.1"),
    jrCollRatio: jrCollRatio || _W("0.1"),
    collRatio: collRatio || _W("0.2"),
    ensuroPpFee: ensuroPpFee || _W("0.05"),
    ensuroCocFee: ensuroCocFee || _W("0.2"),
    jrRoc: jrRoc || _W("0.1"),
    srRoc: srRoc || _W("0.2"),
    asParams: function () {
      return [this.moc, this.jrCollRatio, this.collRatio, this.ensuroPpFee, this.ensuroCocFee, this.jrRoc, this.srRoc];
    },
  };
}
