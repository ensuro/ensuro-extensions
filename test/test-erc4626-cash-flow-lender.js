const { expect } = require("chai");
const {
  amountFunction,
  getTransactionEvent,
  accessControlMessage,
  makeQuoteMessage,
  makeSignedQuote,
} = require("@ensuro/core/js/utils");
const {
  initCurrency,
  deployPool,
  deployPremiumsAccount,
  addRiskModule,
  addEToken,
} = require("@ensuro/core/js/test-utils");
const { newPolicy, defaultPolicyParams, makeBatchParams } = require("./test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { ethers } = hre;
const { AddressZero } = ethers.constants;

describe("ERC4626CashFlowLender contract tests", function () {
  let _A;
  let anon, changeRm, creator, cust, guardian, lp, lp2, owner, resolver, signer;

  beforeEach(async () => {
    [, lp, lp2, cust, signer, resolver, creator, anon, owner, guardian, changeRm] = await ethers.getSigners();

    _A = amountFunction(6);
  });

  async function deployPoolFixture(creationIsOpen) {
    creationIsOpen = creationIsOpen === undefined ? true : creationIsOpen;
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(50000) },
      [lp, lp2, cust, owner],
      [_A(10000), _A(10000), _A(2000), _A(1000)]
    );

    const pool = await deployPool({
      currency: currency.address,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
    });
    pool._A = _A;

    const accessManager = await ethers.getContractAt("AccessManager", await pool.access());

    // Setup the liquidity sources
    const etk = await addEToken(pool, {});
    const premiumsAccount = await deployPremiumsAccount(pool, { srEtkAddr: etk.address });

    // Provide some liquidity
    await currency.connect(lp).approve(pool.address, _A(5000));
    await pool.connect(lp).deposit(etk.address, _A(5000));

    // Customer approval
    await currency.connect(cust).approve(pool.address, _A(500));

    // Setup the risk module
    const SignedQuoteRiskModule = await ethers.getContractFactory("SignedQuoteRiskModule");
    const rm = await addRiskModule(pool, premiumsAccount, SignedQuoteRiskModule, {
      ensuroFee: 0.03,
      extraConstructorArgs: [creationIsOpen],
    });

    await accessManager.grantComponentRole(rm.address, await rm.PRICER_ROLE(), signer.address);

    const ERC4626CashFlowLender = await ethers.getContractFactory("ERC4626CashFlowLender");
    const erc4626cfl = await hre.upgrades.deployProxy(ERC4626CashFlowLender, [rm.address, currency.address], {
      kind: "uups",
    });

    await accessManager.grantComponentRole(rm.address, await rm.RESOLVER_ROLE(), erc4626cfl.address);
    await accessManager.grantComponentRole(rm.address, await rm.PRICER_ROLE(), erc4626cfl.address);
    await erc4626cfl.grantRole(await erc4626cfl.LP_ROLE(), lp.address);
    await erc4626cfl.grantRole(await erc4626cfl.CUSTOMER_ROLE(), cust.address);
    await erc4626cfl.grantRole(await erc4626cfl.CHANGE_RM_ROLE(), changeRm.address);
    await erc4626cfl.grantRole(await erc4626cfl.RESOLVER_ROLE(), resolver.address);
    await erc4626cfl.grantRole(await erc4626cfl.POLICY_CREATOR_ROLE(), creator.address);
    await erc4626cfl.grantRole(await erc4626cfl.GUARDIAN_ROLE(), guardian.address);

    return { etk, premiumsAccount, rm, pool, accessManager, currency, erc4626cfl };
  }

  it("ERC4626CashFlowLender init", async () => {
    const { rm, erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    expect(await erc4626cfl.riskModule()).to.equal(rm.address);
    expect(await erc4626cfl.asset()).to.equal(currency.address);
    expect(await erc4626cfl.totalAssets()).to.equal(0);
  });

  it("Should not allow address(0) for the RM and Asset", async () => {
    const { rm, currency } = await helpers.loadFixture(deployPoolFixture);

    const ERC4626CashFlowLender = await ethers.getContractFactory("ERC4626CashFlowLender");
    await expect(
      hre.upgrades.deployProxy(ERC4626CashFlowLender, [AddressZero, currency.address], {
        kind: "uups",
      })
    ).to.be.revertedWith("ERC4626CashFlowLender: riskModule_ cannot be zero address");

    await expect(
      hre.upgrades.deployProxy(ERC4626CashFlowLender, [rm.address, AddressZero], {
        kind: "uups",
      })
    ).to.be.revertedWith("ERC4626CashFlowLender: asset_ cannot be zero address");
  });

  it("Only CHANGE_RM_ROLE can change the RM", async () => {
    const { rm, pool, premiumsAccount, erc4626cfl } = await helpers.loadFixture(deployPoolFixture);

    const SignedQuoteRiskModule = await ethers.getContractFactory("SignedQuoteRiskModule");
    const newImpl = await SignedQuoteRiskModule.deploy(pool.address, premiumsAccount.address, false);

    expect(await erc4626cfl.riskModule()).to.equal(rm.address);

    await expect(erc4626cfl.connect(anon).setRiskModule(newImpl.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "CHANGE_RM_ROLE")
    );
    await expect(erc4626cfl.connect(changeRm).setRiskModule(AddressZero)).to.be.revertedWith(
      "ERC4626CashFlowLender: riskModule_ cannot be zero address"
    );

    expect(await erc4626cfl.riskModule()).to.equal(rm.address);

    await expect(erc4626cfl.connect(changeRm).setRiskModule(newImpl.address))
      .to.emit(erc4626cfl, "RiskModuleChanged")
      .withArgs(newImpl.address);

    expect(await erc4626cfl.riskModule()).to.equal(newImpl.address);
  });

  it("Creates a policy paid by the ERC4626CashFlowLender", async () => {
    const { rm, pool, currency, erc4626cfl } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address, premium: _A(200) });
    const signature = await makeSignedQuote(signer, policyParams);

    await expect(newPolicy(erc4626cfl, creator, policyParams, cust, signature)).to.be.revertedWith(
      "ERC20: transfer amount exceeds balance" // No funds in erc4626cfl
    );
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(0));
    await currency.connect(cust).transfer(erc4626cfl.address, _A(1000));
    const tx = await newPolicy(erc4626cfl, creator, policyParams, cust, signature);
    const receipt = await tx.wait();
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(800)); // 200 spent on the premium
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200));

    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const policyId = newPolicyEvt.args[1].id;
    expect(await pool.ownerOf(policyId)).to.be.equal(erc4626cfl.address);

    await expect(erc4626cfl.connect(anon).resolvePolicy(newPolicyEvt.args[1], _A(800))).to.be.revertedWith(
      accessControlMessage(anon.address, null, "RESOLVER_ROLE")
    );

    await erc4626cfl.connect(resolver).resolvePolicy(newPolicyEvt.args[1], _A(800));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200) - _A(800)); // 200 prev debt - 800 payout
  });

  ["newPolicy"].map((method) =>
    it(`Rejects if called by unauthorized user - ${method}`, async () => {
      const { rm, erc4626cfl } = await helpers.loadFixture(deployPoolFixture);
      const policyParams = await defaultPolicyParams({ rmAddress: rm.address, premium: _A(200) });
      const signature = await makeSignedQuote(signer, policyParams);

      await expect(newPolicy(erc4626cfl, anon, policyParams, cust, signature, method)).to.be.revertedWith(
        accessControlMessage(anon.address, null, "POLICY_CREATOR_ROLE")
      );
    })
  );

  it("Address without LP_ROLE can't withdraw/redeem", async () => {
    const { rm, erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address, payout: _A(800), premium: _A(200) });
    const signature = await makeSignedQuote(signer, policyParams);

    await currency.connect(cust).transfer(erc4626cfl.address, _A(800));
    await newPolicy(erc4626cfl, creator, policyParams, cust, signature);

    await expect(erc4626cfl.connect(anon).withdraw(_A(800), owner.address, anon.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "LP_ROLE")
    );

    await expect(erc4626cfl.connect(anon).redeem(_A(800), owner.address, anon.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "LP_ROLE")
    );
  });

  it("Only GUARDIAN_ROLE can upgrade", async () => {
    const { pool, erc4626cfl, premiumsAccount } = await helpers.loadFixture(deployPoolFixture);

    // Setup the risk module
    const SignedQuoteRiskModule = await ethers.getContractFactory("SignedQuoteRiskModule");
    const newImpl = await SignedQuoteRiskModule.deploy(pool.address, premiumsAccount.address, false);

    await expect(erc4626cfl.connect(anon).upgradeTo(newImpl.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "GUARDIAN_ROLE")
    );

    await erc4626cfl.connect(guardian).upgradeTo(newImpl.address);
  });

  it("Checks policy expires OK and withdraw", async () => {
    const { rm, pool, erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    let policyParams = await defaultPolicyParams({ rmAddress: rm.address, payout: _A(800), premium: _A(200) });
    const signature = await makeSignedQuote(signer, policyParams);

    await currency.connect(lp).approve(erc4626cfl.address, _A(5000));
    await erc4626cfl.connect(lp).deposit(_A(1000), lp.address);
    let tx = await newPolicy(erc4626cfl, creator, policyParams, cust, signature);
    let receipt = await tx.wait();
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200));
    let newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    //
    await helpers.time.increaseTo(newPolicyEvt.args[1].expiration + 500);
    // Expire the policy
    await expect(pool.expirePolicy(newPolicyEvt.args[1])).not.to.emit(erc4626cfl, "DebtChanged");
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(800));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));

    // try to withdraw the funds
    await expect(erc4626cfl.connect(lp).withdraw(_A(1000), anon.address, lp.address)).to.be.revertedWith(
      "ERC4626: withdraw more than max"
    );
    await erc4626cfl.connect(lp).withdraw(_A(100), anon.address, lp.address);

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200)); // dont change
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(700)); // 800 prev - 100 withdraw
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(900)); // 1000 prev - 100 withdraw
  });

  it("Address without LP_ROLE can't deposit/mint", async () => {
    const { erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    await currency.connect(cust).transfer(erc4626cfl.address, _A(800));
    await expect(erc4626cfl.connect(anon).deposit(_A(800), anon.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "LP_ROLE")
    );

    await expect(erc4626cfl.connect(anon).mint(_A(800), erc4626cfl.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "LP_ROLE")
    );
  });

  it("Customer cashout", async () => {
    const { rm, pool, currency, erc4626cfl } = await helpers.loadFixture(deployPoolFixture);
    let policyParams = await defaultPolicyParams({ rmAddress: rm.address, premium: _A(200) });
    let signature = await makeSignedQuote(signer, policyParams);

    await currency.connect(owner).transfer(erc4626cfl.address, _A(1000));
    let tx = await newPolicy(erc4626cfl, creator, policyParams, cust, signature);
    let receipt = await tx.wait();
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(800));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));

    let newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    await expect(erc4626cfl.connect(resolver).resolvePolicy(newPolicyEvt.args[1], _A(150)))
      .to.emit(erc4626cfl, "DebtChanged")
      .withArgs(_A(50));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(50));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(950));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));
    expect(await currency.balanceOf(cust.address)).to.be.equal(_A(2000)); // 2000 initial

    // 2nd Policy
    policyParams = await defaultPolicyParams({
      rmAddress: rm.address,
      premium: _A(100),
      payout: _A(500),
      policyData: "0x2cbef6744ebcff4969e06c41631a1d0aa71366c4fd997e9ff5a59b8efa9b9032",
    });
    signature = await makeSignedQuote(signer, policyParams);

    tx = await newPolicy(erc4626cfl, creator, policyParams, cust, signature);
    receipt = await tx.wait();
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(150));
    newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

    await expect(erc4626cfl.connect(anon).resolvePolicyFullPayout(newPolicyEvt.args[1], true)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "RESOLVER_ROLE")
    );

    await expect(erc4626cfl.connect(resolver).resolvePolicyFullPayout(newPolicyEvt.args[1], true))
      .to.emit(erc4626cfl, "DebtChanged")
      .withArgs(_A(150 - 500)); // 150 prev debt - 500 payout = -350

    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(1350));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(-350));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));

    await expect(erc4626cfl.connect(anon).cashOutPayouts(_A(500), cust.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "CUSTOMER_ROLE")
    );
    await expect(erc4626cfl.connect(cust).cashOutPayouts(_A(351), cust.address)).to.be.revertedWith(
      "ERC4626CashFlowLender: amount must be less than debt"
    );
    await expect(erc4626cfl.connect(cust).cashOutPayouts(_A(350), cust.address))
      .to.emit(erc4626cfl, "CashOutPayout")
      .withArgs(cust.address, _A(350));

    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(1000));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));
  });

  it("Create and resolve policies in batch paid by the ERC4626CashFlowLender", async () => {
    const { rm, pool, currency, erc4626cfl } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = [
      await defaultPolicyParams({ rmAddress: rm.address, premium: _A(200), payout: _A(900) }),
      await defaultPolicyParams({
        rmAddress: rm.address,
        premium: _A(300),
        payout: _A(950),
        policyData: "0xb494869573b0a0ce9caac5394e1d0d255d146ec7e2d30d643a4e1d78980f3236",
      }),
      await defaultPolicyParams({
        rmAddress: rm.address,
        premium: _A(100),
        payout: _A(800),
        policyData: "0xb494869573b0a0ce9caac5394e1d0d255d146ec7e2d30d643a4e1d78980f3237",
      }),
    ];
    const quoteMessages = policyParams.map(makeQuoteMessage);
    const signatures = await Promise.all(
      quoteMessages.map(async (qm) => ethers.utils.splitSignature(await signer.signMessage(ethers.utils.arrayify(qm))))
    );

    await expect(
      erc4626cfl.connect(anon).newPoliciesInBatch(...makeBatchParams(policyParams, signatures))
    ).to.be.revertedWith(accessControlMessage(anon.address, null, "POLICY_CREATOR_ROLE"));

    await expect(
      erc4626cfl.connect(creator).newPoliciesInBatch(...makeBatchParams(policyParams, signatures))
    ).to.be.revertedWith("ERC20: transfer amount exceeds balance");

    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(0));

    // Transfer some money, not enough to cover all the premiums
    await currency.connect(owner).transfer(erc4626cfl.address, _A(300));

    await expect(
      erc4626cfl.connect(creator).newPoliciesInBatch(...makeBatchParams(policyParams, signatures))
    ).to.be.revertedWith("ERC20: transfer amount exceeds balance");

    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(300));

    await currency.connect(owner).transfer(erc4626cfl.address, _A(500));

    const tx = await erc4626cfl.connect(creator).newPoliciesInBatch(...makeBatchParams(policyParams, signatures));
    const receipt = await tx.wait();
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(200)); // 600 spent on the premium
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(600));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(800));
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const policyId = newPolicyEvt.args[1].id;
    expect(await pool.ownerOf(policyId)).to.be.equal(erc4626cfl.address);

    // for each log in the transaction receipt
    const newPolicyEvts = [];
    for (const log of receipt.logs) {
      let parsedLog;
      try {
        parsedLog = pool.interface.parseLog(log);
      } catch (error) {
        continue;
      }
      if (parsedLog.name == "NewPolicy") {
        newPolicyEvts.push(parsedLog);
      }
    }

    expect(newPolicyEvts.length).to.be.equal(3);
    expect(await pool.ownerOf(newPolicyEvts[1].args[1].id)).to.be.equal(erc4626cfl.address);
    expect(await pool.ownerOf(newPolicyEvts[2].args[1].id)).to.be.equal(erc4626cfl.address);

    await expect(
      erc4626cfl
        .connect(anon)
        .resolvePoliciesInBatch(
          [newPolicyEvts[0].args[1], newPolicyEvts[1].args[1], newPolicyEvts[2].args[1]],
          [_A(300), _A(300), _A(300)]
        )
    ).to.be.revertedWith(accessControlMessage(anon.address, null, "RESOLVER_ROLE"));

    const resolveTx = await erc4626cfl
      .connect(resolver)
      .resolvePoliciesInBatch(
        [newPolicyEvts[0].args[1], newPolicyEvts[1].args[1], newPolicyEvts[2].args[1]],
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
      if (parsedLog.name == "PolicyResolved") {
        resolvePolicyEvts.push(parsedLog);
      }
    }
    expect(resolvePolicyEvts.length).to.be.equal(3);

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(-300)); // 600 prev debt - (300 payout * 3 )
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(1100));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(800));

    await currency.connect(lp).approve(erc4626cfl.address, _A(300));
    await erc4626cfl.connect(lp).deposit(_A(300), lp.address);

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(-300)); // dont change
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(1400)); // 1100 prev + 300 deposit
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1100));
    expect(await erc4626cfl.convertToAssets(_A(1100))).not.to.be.equal(_A(1100));
  });

  it.skip("Creates a policy paid by holder", async () => {
    const { rm, pool, currency, erc4626cfl } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address, premium: _A(200) });
    const signature = await makeSignedQuote(signer, policyParams);

    await currency.connect(cust).transfer(erc4626cfl.address, _A(1000));

    const tx = await newPolicy(erc4626cfl, creator, policyParams, cust, signature, "newPolicyPaidByHolder");
    const receipt = await tx.wait();
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200));
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const policyId = newPolicyEvt.args[1].id;
    expect(await pool.ownerOf(policyId)).to.be.equal(erc4626cfl.address);

    await erc4626cfl.connect(resolver).resolvePolicy(newPolicyEvt.args[1], _A(800));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200) - _A(800)); // 200 prev debt - 800 payout
  });

  it("Only LP_ROLE can deposit/mint", async () => {
    const { erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    await expect(erc4626cfl.connect(anon).deposit(_A(800), anon.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "LP_ROLE")
    );

    await expect(erc4626cfl.connect(anon).mint(_A(800), owner.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "LP_ROLE")
    );

    expect(await currency.balanceOf(lp.address)).to.be.equal(_A(5000));

    await currency.connect(lp).approve(erc4626cfl.address, _A(5000));
    await erc4626cfl.connect(lp).deposit(_A(800), lp.address);

    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(800));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(800));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(lp.address)).to.be.equal(_A(4200));

    expect(await erc4626cfl.convertToAssets(_A(800))).to.be.equal(_A(800));
    await erc4626cfl.connect(lp).mint(_A(300), erc4626cfl.address);

    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(1100));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1100));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(lp.address)).to.be.equal(_A(3900));
  });

  it("Custom test case", async () => {
    const { rm, pool, currency, erc4626cfl } = await helpers.loadFixture(deployPoolFixture);
    let policyParams = await defaultPolicyParams({ rmAddress: rm.address, premium: _A(40), payout: _A(100) });
    let signature = await makeSignedQuote(signer, policyParams);

    await currency.connect(lp).approve(erc4626cfl.address, _A(1000));
    await erc4626cfl.connect(lp).deposit(_A(100), lp.address);
    const tx = await newPolicy(erc4626cfl, creator, policyParams, cust, signature);
    const receipt = await tx.wait();

    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const policyId = newPolicyEvt.args[1].id;
    expect(await pool.ownerOf(policyId)).to.be.equal(erc4626cfl.address);

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(40));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(60));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(100));

    // Try to withdraw the funds
    await expect(erc4626cfl.connect(lp).withdraw(_A(100), anon.address, lp.address)).to.be.revertedWith(
      "ERC4626: withdraw more than max"
    );
    await expect(erc4626cfl.connect(lp).redeem(_A(100), anon.address, lp.address)).to.be.revertedWith(
      "ERC4626: redeem more than max"
    );

    await erc4626cfl.connect(resolver).resolvePolicy(newPolicyEvt.args[1], _A(80));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(40) - _A(80)); // 40 prev debt - 80 payout = -40
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(140));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(100));
  });

  it("Only deposit and withdraw", async () => {
    const { erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    await currency.connect(lp).approve(erc4626cfl.address, _A(5000));
    await erc4626cfl.connect(lp).deposit(_A(1000), lp.address);

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(1000));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));
    expect(await currency.balanceOf(anon.address)).to.be.equal(_A(0));

    await erc4626cfl.connect(lp).withdraw(_A(100), anon.address, lp.address);

    expect(await currency.balanceOf(anon.address)).to.be.equal(_A(100));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(900));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(900));

    // lp deposit shares to anon
    await erc4626cfl.connect(lp).deposit(_A(200), anon.address);
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(1100));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1100));
    expect(await currency.balanceOf(anon.address)).to.be.equal(_A(100));

    // can't withdraw because he doenst have LP_ROLE
    await expect(erc4626cfl.connect(anon).withdraw(_A(200), lp.address, anon.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "LP_ROLE")
    );
    // give permission to anon
    await erc4626cfl.grantRole(await erc4626cfl.LP_ROLE(), anon.address);
    // try to withdraw more than he has
    await expect(erc4626cfl.connect(anon).withdraw(_A(300), lp.address, anon.address)).to.be.revertedWith(
      "ERC4626: withdraw more than max"
    );

    // now he can withdraw
    await erc4626cfl.connect(anon).withdraw(_A(200), anon.address, anon.address);

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(900));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(900));
    expect(await currency.balanceOf(anon.address)).to.be.equal(_A(300));
  });

  it("New RM must belong to the same pool", async () => {
    const { rm, erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    const otherPool = await deployPool({
      currency: currency.address,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1", // Other Random address
    });
    otherPool._A = _A;

    const premiumsAccount = await deployPremiumsAccount(otherPool, {}, false);

    const SignedQuoteRiskModule = await ethers.getContractFactory("SignedQuoteRiskModule");
    const newImpl = await SignedQuoteRiskModule.deploy(otherPool.address, premiumsAccount.address, false);

    expect(await erc4626cfl.riskModule()).to.equal(rm.address);

    await expect(erc4626cfl.connect(changeRm).setRiskModule(newImpl.address)).to.be.revertedWith(
      "ERC4626CashFlowLender: new riskModule must belong to the same pool"
    );

    expect(await erc4626cfl.riskModule()).to.equal(rm.address); // dont change
  });

  it("Only ERC4626 maxWithdraw", async () => {
    const { erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    await currency.connect(lp).approve(erc4626cfl.address, _A(5000));
    await erc4626cfl.connect(lp).deposit(_A(1000), lp.address);

    expect(await erc4626cfl.maxWithdraw(lp.address)).to.be.equal(_A(1000));
    expect(await erc4626cfl.maxWithdraw(cust.address)).to.be.equal(_A(0));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(1000));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));

    await currency.connect(cust).transfer(erc4626cfl.address, _A(1000));

    expect(await erc4626cfl.maxWithdraw(lp.address)).to.be.closeTo(_A(2000), _A(0.01));
    expect(await erc4626cfl.maxWithdraw(cust.address)).to.be.equal(_A(0));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(2000));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(2000));
  });

  it("Only ERC4626 maxRedeem", async () => {
    const { erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    await currency.connect(lp).approve(erc4626cfl.address, _A(5000));
    await erc4626cfl.connect(lp).deposit(_A(1000), lp.address);

    expect(await erc4626cfl.maxRedeem(lp.address)).to.be.equal(_A(1000));
    expect(await erc4626cfl.maxRedeem(cust.address)).to.be.equal(_A(0));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(1000));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));

    await currency.connect(cust).transfer(erc4626cfl.address, _A(1000));

    expect(await erc4626cfl.maxRedeem(lp.address)).to.be.equal(_A(1000));
    expect(await erc4626cfl.maxRedeem(cust.address)).to.be.equal(_A(0));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(2000));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(2000));
  });

  it("Two LPs with policies - maxWithdraw/maxRedeem - assets == shares ", async () => {
    const { rm, pool, erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    let policyParams = await defaultPolicyParams({ rmAddress: rm.address, payout: _A(800), premium: _A(200) });
    const signature = await makeSignedQuote(signer, policyParams);

    await erc4626cfl.grantRole(await erc4626cfl.LP_ROLE(), lp2.address);

    await currency.connect(lp).approve(erc4626cfl.address, _A(5000));
    await currency.connect(lp2).approve(erc4626cfl.address, _A(5000));
    await erc4626cfl.connect(lp).deposit(_A(500), lp.address);
    await erc4626cfl.connect(lp2).deposit(_A(500), lp2.address);

    // Check maxWithdraw and maxRedeem
    expect(await erc4626cfl.maxWithdraw(lp.address)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxWithdraw(lp2.address)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(lp.address)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(lp2.address)).to.be.equal(_A(500));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(1000));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));

    // First policy, should increase the debt to 200 and decrease the balance
    let tx = await newPolicy(erc4626cfl, creator, policyParams, cust, signature);
    let receipt = await tx.wait();
    let newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(800));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));

    // same maxWithdraw and maxRedeem ( assets == shares )
    expect(await erc4626cfl.maxWithdraw(lp.address)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxWithdraw(lp2.address)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(lp.address)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(lp2.address)).to.be.equal(_A(500));

    await erc4626cfl.connect(lp).withdraw(_A(100), lp.address, lp.address);
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(700));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(900));

    expect(await erc4626cfl.maxWithdraw(lp.address)).to.be.equal(_A(400));
    expect(await erc4626cfl.maxWithdraw(lp2.address)).to.be.equal(_A(500));

    expect(await erc4626cfl.maxRedeem(lp.address)).to.be.equal(_A(400));
    expect(await erc4626cfl.maxRedeem(lp2.address)).to.be.equal(_A(500));

    await erc4626cfl.connect(resolver).resolvePolicy(newPolicyEvt.args[1], _A(800));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200) - _A(800)); // 200 prev debt - 800 payout = -600
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(1500));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(900));

    expect(await erc4626cfl.maxWithdraw(lp.address)).to.be.equal(_A(400));
    expect(await erc4626cfl.maxWithdraw(lp2.address)).to.be.equal(_A(500));

    await erc4626cfl.connect(lp).withdraw(_A(170), lp.address, lp.address);
    expect(await erc4626cfl.maxWithdraw(lp.address)).to.be.equal(_A(230));
    expect(await erc4626cfl.maxWithdraw(lp2.address)).to.be.equal(_A(500));

    expect(await erc4626cfl.maxRedeem(lp.address)).to.be.equal(_A(230));
    expect(await erc4626cfl.maxRedeem(lp2.address)).to.be.equal(_A(500));

    await erc4626cfl.connect(lp).withdraw(_A(230), lp.address, lp.address);
    expect(await erc4626cfl.maxWithdraw(lp.address)).to.be.equal(_A(0));
    expect(await erc4626cfl.maxWithdraw(lp2.address)).to.be.equal(_A(500));

    expect(await erc4626cfl.maxRedeem(lp.address)).to.be.equal(_A(0));
    expect(await erc4626cfl.maxRedeem(lp2.address)).to.be.equal(_A(500));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(-600));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(1100));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(500));

    await erc4626cfl.connect(lp2).withdraw(_A(500), lp2.address, lp2.address);
    expect(await erc4626cfl.maxWithdraw(lp2.address)).to.be.equal(_A(0));

    expect(await erc4626cfl.maxRedeem(lp2.address)).to.be.equal(_A(0));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(-600));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(600));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(0));
  });

  it("Two LPs without policies - maxWithdraw/maxRedeem - assets !== shares", async () => {
    const { erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    await erc4626cfl.grantRole(await erc4626cfl.LP_ROLE(), lp2.address);

    await currency.connect(lp).approve(erc4626cfl.address, _A(5000));
    await currency.connect(lp2).approve(erc4626cfl.address, _A(5000));
    await erc4626cfl.connect(lp).deposit(_A(500), lp.address);
    await erc4626cfl.connect(lp2).deposit(_A(500), lp2.address);

    // Check maxWithdraw and maxRedeem
    expect(await erc4626cfl.maxWithdraw(lp.address)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxWithdraw(lp2.address)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(lp.address)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(lp2.address)).to.be.equal(_A(500));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(1000));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));

    // "Free money" -> assets != shares
    await currency.connect(cust).transfer(erc4626cfl.address, _A(1000));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(2000));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(2000));

    // maxWithdraw increase to 1000
    expect(await erc4626cfl.maxWithdraw(lp.address)).to.be.closeTo(_A(1000), _A("0.01"));
    expect(await erc4626cfl.maxWithdraw(lp2.address)).to.be.closeTo(_A(1000), _A("0.01"));
    // maxRedeem is the same
    expect(await erc4626cfl.maxRedeem(lp.address)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(lp2.address)).to.be.equal(_A(500));

    // Withdraw almost all of the funds from lp
    await erc4626cfl.connect(lp).withdraw(_A("999.9999"), lp.address, lp.address);
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.closeTo(_A(1000), _A("0.0001"));
    expect(await erc4626cfl.totalAssets()).to.be.closeTo(_A(1000), _A("0.0001"));

    expect(await erc4626cfl.maxWithdraw(lp.address)).to.be.closeTo(_A(0), _A("0.01"));
    expect(await erc4626cfl.maxWithdraw(lp2.address)).to.be.closeTo(_A(1000), _A("0.01"));

    expect(await erc4626cfl.maxRedeem(lp.address)).to.be.closeTo(_A(0), _A("0.01"));
    expect(await erc4626cfl.maxRedeem(lp2.address)).to.be.equal(_A(500));

    expect(await currency.balanceOf(lp.address)).to.be.closeTo(_A("5499.9999"), _A("0.001")); // 5000 initial - 500 deposit + 1000 withdraw

    // try to withdraw more than he has
    await expect(erc4626cfl.connect(lp2).withdraw(_A(1100), lp2.address, lp2.address)).to.be.revertedWith(
      "ERC4626: withdraw more than max"
    );

    // try to redeem more than he has
    await expect(erc4626cfl.connect(lp2).redeem(_A(501), lp2.address, lp2.address)).to.be.revertedWith(
      "ERC4626: redeem more than max"
    );

    await erc4626cfl.connect(lp2).withdraw(_A(100), lp2.address, lp2.address);
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.closeTo(_A(900), _A("0.0001"));
    expect(await erc4626cfl.totalAssets()).to.be.closeTo(_A(900), _A("0.0001"));

    expect(await erc4626cfl.maxWithdraw(lp2.address)).to.be.closeTo(_A(900), _A("0.01"));
    expect(await erc4626cfl.maxRedeem(lp2.address)).to.be.equal(_A(450)); // withdraw 100 -> 50 assets and 50 shares

    expect(await currency.balanceOf(lp2.address)).to.be.equal(_A(9600)); // 10k initial - 500 deposit + 100 withdraw
  });

  it("Two LPs with policies - maxRedeem ", async () => {
    const { rm, pool, erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    let policyParams = await defaultPolicyParams({ rmAddress: rm.address, payout: _A(800), premium: _A(200) });
    const signature = await makeSignedQuote(signer, policyParams);

    await erc4626cfl.grantRole(await erc4626cfl.LP_ROLE(), lp2.address);

    await currency.connect(lp).approve(erc4626cfl.address, _A(5000));
    await currency.connect(lp2).approve(erc4626cfl.address, _A(5000));
    await erc4626cfl.connect(lp).deposit(_A(500), lp.address);
    await erc4626cfl.connect(lp2).deposit(_A(500), lp2.address);

    expect(await erc4626cfl.maxRedeem(lp.address)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(lp2.address)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(anon.address)).to.be.equal(_A(0));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(1000));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));

    let tx = await newPolicy(erc4626cfl, creator, policyParams, cust, signature);
    let receipt = await tx.wait();
    let newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(800));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));

    expect(await erc4626cfl.maxRedeem(lp.address)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(lp2.address)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(anon.address)).to.be.equal(_A(0));

    await erc4626cfl.connect(lp).redeem(_A(100), anon.address, lp.address);
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(700));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(900));

    expect(await erc4626cfl.maxRedeem(lp.address)).to.be.equal(_A(400));
    expect(await erc4626cfl.maxRedeem(lp2.address)).to.be.equal(_A(500));

    await erc4626cfl.connect(resolver).resolvePolicy(newPolicyEvt.args[1], _A(800));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200) - _A(800)); // 200 prev debt - 800 payout = -600
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(1500));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(900));

    expect(await erc4626cfl.maxRedeem(lp.address)).to.be.equal(_A(400));
    expect(await erc4626cfl.maxRedeem(lp2.address)).to.be.equal(_A(500));

    await erc4626cfl.connect(lp).redeem(_A(170), anon.address, lp.address);
    expect(await erc4626cfl.maxRedeem(lp.address)).to.be.equal(_A(230));
    expect(await erc4626cfl.maxRedeem(lp2.address)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(anon.address)).to.be.equal(_A(0));

    await erc4626cfl.connect(lp).redeem(_A(230), anon.address, lp.address);
    expect(await erc4626cfl.maxRedeem(lp.address)).to.be.equal(_A(0));
    expect(await erc4626cfl.maxRedeem(lp2.address)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(anon.address)).to.be.equal(_A(0));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(-600));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(1100));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(500));

    await erc4626cfl.connect(lp2).redeem(_A(500), anon.address, lp2.address);
    expect(await erc4626cfl.maxRedeem(lp2.address)).to.be.equal(_A(0));
    expect(await erc4626cfl.maxRedeem(lp.address)).to.be.equal(_A(0));
    expect(await erc4626cfl.maxRedeem(anon.address)).to.be.equal(_A(0));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(-600));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(600));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(0));
  });

  it("Two LPs without policies - maxRedeem", async () => {
    const { erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    await erc4626cfl.grantRole(await erc4626cfl.LP_ROLE(), lp2.address);

    expect(await currency.balanceOf(lp.address)).to.be.equal(_A(5000));
    expect(await currency.balanceOf(lp2.address)).to.be.equal(_A(10000));

    await currency.connect(lp).approve(erc4626cfl.address, _A(5000));
    await currency.connect(lp2).approve(erc4626cfl.address, _A(5000));
    await erc4626cfl.connect(lp).deposit(_A(500), lp.address);
    await erc4626cfl.connect(lp2).deposit(_A(500), lp2.address);

    expect(await erc4626cfl.maxRedeem(lp.address)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(lp2.address)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(anon.address)).to.be.equal(_A(0));

    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(1000));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(1000));

    await currency.connect(cust).transfer(erc4626cfl.address, _A(1000));
    expect(await erc4626cfl.totalAssets()).to.be.equal(_A(2000));
    expect(await erc4626cfl.totalSupply()).to.be.equal(_A(1000));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(2000));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));

    expect(await erc4626cfl.maxRedeem(lp.address)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(lp2.address)).to.be.equal(_A(500));
    expect(await erc4626cfl.maxRedeem(anon.address)).to.be.equal(_A(0));

    expect(await erc4626cfl.maxWithdraw(lp.address)).to.be.closeTo(_A(1000), _A("0.001"));
    expect(await erc4626cfl.maxWithdraw(lp2.address)).to.be.closeTo(_A(1000), _A("0.001"));
    expect(await erc4626cfl.maxWithdraw(anon.address)).to.be.equal(_A(0));

    expect(await currency.balanceOf(lp.address)).to.be.equal(_A(4500)); // 5000 initial - 500 deposit

    await erc4626cfl.connect(lp).redeem(_A(500), lp.address, lp.address);
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.closeTo(_A(1000), _A("0.01"));
    expect(await erc4626cfl.totalAssets()).to.be.closeTo(_A(1000), _A("0.01"));

    expect(await erc4626cfl.maxRedeem(lp.address)).to.be.equal(_A(0));
    expect(await erc4626cfl.maxRedeem(lp2.address)).to.be.equal(_A(500));

    expect(await currency.balanceOf(lp.address)).to.be.closeTo(_A("5499.9999"), _A("0.001")); // 5000 initial - 500 deposit + 500 redeem + 499 shares

    // try to redeem more than he has
    await expect(erc4626cfl.connect(lp2).redeem(_A(501), lp2.address, lp2.address)).to.be.revertedWith(
      "ERC4626: redeem more than max"
    );

    await erc4626cfl.connect(lp2).redeem(_A(100), lp2.address, lp2.address);
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(erc4626cfl.address)).to.be.closeTo(_A(800), _A("0.0001"));
    expect(await erc4626cfl.totalAssets()).to.be.closeTo(_A(800), _A("0.0001"));

    expect(await erc4626cfl.maxRedeem(lp.address)).to.be.closeTo(_A(0), _A("0.01"));
    expect(await erc4626cfl.maxRedeem(lp2.address)).to.be.equal(_A(400));

    expect(await currency.balanceOf(lp2.address)).to.be.equal(_A(9700)); // 10k initial - 500 deposit + 100 redeem + 100 shares
  });
});
