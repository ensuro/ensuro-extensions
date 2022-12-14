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

describe("CashFlowLender contract tests", function () {
  let _A;
  let lp, cust, signer, resolver, creator, anon;

  beforeEach(async () => {
    [__, lp, cust, signer, resolver, creator, anon, owner] = await hre.ethers.getSigners();

    _A = amountFunction(6);
  });

  async function deployPoolFixture(creationIsOpen) {
    creationIsOpen = creationIsOpen === undefined ? true : creationIsOpen;
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
    const SignedQuoteRiskModule = await hre.ethers.getContractFactory("SignedQuoteRiskModule");
    const rm = await addRiskModule(pool, premiumsAccount, SignedQuoteRiskModule, {
      ensuroFee: 0.03,
      extraConstructorArgs: [creationIsOpen],
    });

    await accessManager.grantComponentRole(rm.address, await rm.PRICER_ROLE(), signer.address);

    const CashFlowLender = await hre.ethers.getContractFactory("CashFlowLender");
    const cfLender = await hre.upgrades.deployProxy(
      CashFlowLender,
      [cust.address],
      {
        kind: "uups",
        unsafeAllow: ["delegatecall"],
        constructorArgs: [rm.address],
      }
    );

    await accessManager.grantComponentRole(rm.address, await rm.POLICY_CREATOR_ROLE(), cfLender.address);
    await accessManager.grantComponentRole(rm.address, await rm.RESOLVER_ROLE(), cfLender.address);
    await cfLender.grantRole(await cfLender.OWNER_ROLE(), owner.address);
    await cfLender.grantRole(await cfLender.RESOLVER_ROLE(), resolver.address);
    await cfLender.grantRole(await cfLender.POLICY_CREATOR_ROLE(), creator.address);

    return { etk, premiumsAccount, rm, pool, accessManager, currency, cfLender };
  }

  function makeQuoteMessage({ rmAddress, payout, premium, lossProb, expiration, policyData, validUntil }) {
    return ethers.utils.solidityPack(
      ["address", "uint256", "uint256", "uint256", "uint40", "bytes32", "uint40"],
      [rmAddress, payout, premium, lossProb, expiration, policyData, validUntil]
    );
  }

  async function defaultPolicyParams({ rmAddress, payout, premium, lossProb, expiration, policyData, validUntil }) {
    const now = await helpers.time.latest();
    return {
      rmAddress,
      payout: payout || _A(1000),
      premium: premium || ethers.constants.MaxUint256,
      lossProb: lossProb || _W(0.1),
      expiration: expiration || now + 3600 * 24 * 30,
      policyData: policyData || "0xb494869573b0a0ce9caac5394e1d0d255d146ec7e2d30d643a4e1d78980f3235",
      validUntil: validUntil || now + 3600 * 24 * 30,
    };
  }

  function newPolicy(rm, sender, policyParams, onBehalfOf, signature, method) {
    if (sender !== undefined) rm = rm.connect(sender);
    return rm[method || "newPolicy"](
      policyParams.payout,
      policyParams.premium,
      policyParams.lossProb,
      policyParams.expiration,
      onBehalfOf.address,
      policyParams.policyData,
      signature.r,
      signature._vs,
      policyParams.validUntil
    );
  }

  it("Creates a policy paid by the CashFlowLender", async () => {
    const { rm, pool, currency, cfLender } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address, premium: _A(200) });
    const quoteMessage = makeQuoteMessage(policyParams);
    const signature = ethers.utils.splitSignature(await signer.signMessage(ethers.utils.arrayify(quoteMessage)));
    await expect(newPolicy(cfLender, creator, policyParams, cust, signature)).to.be.revertedWith(
      "ERC20: transfer amount exceeds balance"  // No funds in cfLender
    );
    expect(await currency.balanceOf(cfLender.address)).to.be.equal(_A(0));
    await currency.connect(owner).transfer(cfLender.address, _A(1000));
    const tx = await newPolicy(cfLender, creator, policyParams, cust, signature);
    const receipt = await tx.wait();
    expect(await currency.balanceOf(cfLender.address)).to.be.equal(_A(800)); // 200 spent on the premium
    expect(await cfLender.currentDebt()).to.be.equal(_A(200));
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const policyId = newPolicyEvt.args[1].id;
    expect(await pool.ownerOf(policyId)).to.be.equal(cfLender.address);

    await cfLender.connect(resolver).resolvePolicy(newPolicyEvt.args[1], _A(800));
    expect(await cfLender.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(cfLender.address)).to.be.equal(_A(1000)); // 200 debt repaid
    expect(await currency.balanceOf(cust.address)).to.be.equal(_A(500 + 600)); // 500 initial + 600 (800-200)
  });

  it("Rejects if called by unauthorized user", async () => {
    const { rm, cfLender } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address, premium: _A(200) });
    const quoteMessage = makeQuoteMessage(policyParams);
    const signature = ethers.utils.splitSignature(await signer.signMessage(ethers.utils.arrayify(quoteMessage)));
    await expect(newPolicy(cfLender, anon, policyParams, cust, signature)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "POLICY_CREATOR_ROLE")
    );
  });

  it("Rejects if resolved by unauthorized user", async () => {
    const { rm, currency, pool, cfLender } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address, premium: _A(200) });
    const quoteMessage = makeQuoteMessage(policyParams);
    const signature = ethers.utils.splitSignature(await signer.signMessage(ethers.utils.arrayify(quoteMessage)));
    await currency.connect(owner).transfer(cfLender.address, _A(1000));
    const tx = await newPolicy(cfLender, creator, policyParams, cust, signature);
    const receipt = await tx.wait();
    expect(await currency.balanceOf(cfLender.address)).to.be.equal(_A(800)); // 200 spent on the premium
    expect(await cfLender.currentDebt()).to.be.equal(_A(200));
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    await expect(cfLender.connect(anon).resolvePolicy(newPolicyEvt.args[1], _A(800))).to.be.revertedWith(
      accessControlMessage(anon.address, null, "RESOLVER_ROLE")
    );
  });

  it("Test no payout to customer because outstanding debt", async () => {
    const { rm, pool, currency, cfLender } = await helpers.loadFixture(deployPoolFixture);
    let policyParams = await defaultPolicyParams({ rmAddress: rm.address, premium: _A(200) });
    let quoteMessage = makeQuoteMessage(policyParams);
    let signature = ethers.utils.splitSignature(await signer.signMessage(ethers.utils.arrayify(quoteMessage)));
    await currency.connect(owner).transfer(cfLender.address, _A(1000));
    let tx = await newPolicy(cfLender, creator, policyParams, cust, signature);
    let receipt = await tx.wait();
    expect(await cfLender.currentDebt()).to.be.equal(_A(200));
    let newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    await expect(cfLender.connect(resolver).resolvePolicy(newPolicyEvt.args[1], _A(150))).to.emit(
      cfLender, "DebtChanged"
    ).withArgs(_A(50));
    expect(await cfLender.currentDebt()).to.be.equal(_A(50));
    expect(await currency.balanceOf(cust.address)).to.be.equal(_A(500)); // 500 initial

    // 2nd Policy
    policyParams = await defaultPolicyParams({
      rmAddress: rm.address,
      premium: _A(100),
      payout: _A(500),
      policyData: "0x2cbef6744ebcff4969e06c41631a1d0aa71366c4fd997e9ff5a59b8efa9b9032"
    });
    quoteMessage = makeQuoteMessage(policyParams);
    signature = ethers.utils.splitSignature(await signer.signMessage(ethers.utils.arrayify(quoteMessage)));
    tx = await newPolicy(cfLender, creator, policyParams, cust, signature, "newPolicyFull");
    receipt = await tx.wait();
    expect(await cfLender.currentDebt()).to.be.equal(_A(150));
    newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

    await expect(cfLender.connect(resolver).resolvePolicyFullPayout(newPolicyEvt.args[1], true)).to.emit(
      cfLender, "DebtChanged"
    ).withArgs(_A(0));
    expect(await currency.balanceOf(cust.address)).to.be.equal(_A(500 + 500 - 150));
  });

  it("Repay debt then payout goes to customer", async () => {
    const { rm, pool, currency, cfLender } = await helpers.loadFixture(deployPoolFixture);
    let policyParams = await defaultPolicyParams({ rmAddress: rm.address, premium: _A(200) });
    let quoteMessage = makeQuoteMessage(policyParams);
    let signature = ethers.utils.splitSignature(await signer.signMessage(ethers.utils.arrayify(quoteMessage)));
    await currency.connect(owner).transfer(cfLender.address, _A(1000));
    let tx = await newPolicy(cfLender, creator, policyParams, cust, signature);
    let receipt = await tx.wait();
    expect(await cfLender.currentDebt()).to.be.equal(_A(200));
    let newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    // Repay debt
    await currency.connect(cust).approve(cfLender.address, _A(500));
    await expect(cfLender.connect(cust).repayDebt(_A(500))).to.emit(
      cfLender, "DebtChanged"
    ).withArgs(_A(0));
    expect(await cfLender.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(cust.address)).to.be.equal(_A(300)); // 500 initial - 200 repaid
    await expect(cfLender.connect(resolver).resolvePolicy(newPolicyEvt.args[1], _A(150))).not.to.emit(
      cfLender, "DebtChanged"
    );
    expect(await currency.balanceOf(cust.address)).to.be.equal(_A(450));
  });

  it("It's possible to change the customer address and other receives the payout", async () => {
    const { rm, pool, currency, cfLender } = await helpers.loadFixture(deployPoolFixture);
    let policyParams = await defaultPolicyParams({ rmAddress: rm.address, premium: _A(200) });
    let quoteMessage = makeQuoteMessage(policyParams);
    let signature = ethers.utils.splitSignature(await signer.signMessage(ethers.utils.arrayify(quoteMessage)));
    await currency.connect(owner).transfer(cfLender.address, _A(1000));
    let tx = await newPolicy(cfLender, creator, policyParams, cust, signature);
    let receipt = await tx.wait();
    expect(await cfLender.currentDebt()).to.be.equal(_A(200));
    let newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

    // Try changing the customer with anon
    await expect(cfLender.connect(anon).setCustomer(anon.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "OWNER_ROLE")
    );
    await expect(cfLender.connect(owner).setCustomer(anon.address)).to.emit(
      cfLender, "CustomerChanged"
    ).withArgs(anon.address);
    expect(await cfLender.customer()).to.be.equal(anon.address);
    await expect(cfLender.connect(resolver).resolvePolicy(newPolicyEvt.args[1], _A(500))).to.emit(
      cfLender, "DebtChanged"
    ).withArgs(_W(0));
    expect(await currency.balanceOf(cust.address)).to.be.equal(_A(500)); // unchanged
    expect(await currency.balanceOf(anon.address)).to.be.equal(_A(300)); // 500 payout - 200 debt
  });

  it("Test only the owner can withdraw the funds", async () => {
    const { rm, pool, currency, cfLender } = await helpers.loadFixture(deployPoolFixture);
    let policyParams = await defaultPolicyParams({ rmAddress: rm.address, premium: _A(200) });
    let quoteMessage = makeQuoteMessage(policyParams);
    let signature = ethers.utils.splitSignature(await signer.signMessage(ethers.utils.arrayify(quoteMessage)));
    await currency.connect(owner).transfer(cfLender.address, _A(1000));
    let tx = await newPolicy(cfLender, creator, policyParams, cust, signature, "newPolicyPaidByHolder");
    let receipt = await tx.wait();
    expect(await cfLender.currentDebt()).to.be.equal(_A(200));
    let newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

    // Try changing the customer with anon
    await expect(cfLender.connect(anon).withdraw(_A(200), anon.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "OWNER_ROLE")
    );
    await expect(cfLender.connect(owner).withdraw(_A(300), anon.address)).to.emit(
      cfLender, "Withdrawal"
    ).withArgs(anon.address, _A(300));
    expect(await currency.balanceOf(anon.address)).to.be.equal(_A(300));
    expect(await currency.balanceOf(cfLender.address)).to.be.equal(_A(1000 - 300 - 200));
    await expect(cfLender.connect(resolver).resolvePolicy(newPolicyEvt.args[1], _A(200))).to.emit(
      cfLender, "DebtChanged"
    ).withArgs(_A(0));
    await expect(cfLender.connect(owner).withdraw(ethers.constants.MaxUint256, anon.address)).to.emit(
      cfLender, "Withdrawal"
    ).withArgs(anon.address, _A(700));
    expect(await currency.balanceOf(anon.address)).to.be.equal(_A(1000));
    expect(await currency.balanceOf(cfLender.address)).to.be.equal(_A(0));
    // When no more funds, withdraw doesn't fails, just doesn't do anything
    await expect(cfLender.connect(owner).withdraw(ethers.constants.MaxUint256, anon.address)).not.to.emit(
      cfLender, "Withdrawal"
    );
  });
});
