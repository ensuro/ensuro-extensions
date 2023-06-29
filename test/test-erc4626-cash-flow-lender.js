const { expect } = require("chai");
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
  makeSignedQuote,
} = require("@ensuro/core/js/test-utils");
const { newPolicy, defaultPolicyParams } = require("./test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

describe("ERC4626CashFlowLender contract tests", function () {
  let _A;
  let lp, cust, signer, resolver, creator, anon, guardian;
  const _tn = (testName) => `${testName}`;

  beforeEach(async () => {
    [__, lp, cust, signer, resolver, creator, anon, owner, guardian, changeRm] = await hre.ethers.getSigners();

    _A = amountFunction(6);
  });

  async function deployPoolFixture(creationIsOpen) {
    creationIsOpen = creationIsOpen === undefined ? true : creationIsOpen;
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(50000) },
      [lp, cust, owner],
      [_A(10000), _A(2000), _A(1000)]
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

    const ERC4626CashFlowLender = await hre.ethers.getContractFactory("ERC4626CashFlowLender");
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

  function makeQuoteMessage({ rmAddress, payout, premium, lossProb, expiration, policyData, validUntil }) {
    return ethers.utils.solidityPack(
      ["address", "uint256", "uint256", "uint256", "uint40", "bytes32", "uint40"],
      [rmAddress, payout, premium, lossProb, expiration, policyData, validUntil]
    );
  }

  function makeBatchParams(policyParams, signatures) {
    const payout = policyParams.map((pp) => pp.payout);
    const premium = policyParams.map((pp) => pp.premium);
    const lossProb = policyParams.map((pp) => pp.lossProb);
    const expiration = policyParams.map((pp) => pp.expiration);
    const policyData = policyParams.map((pp) => pp.policyData);
    const quoteSignatureR = signatures.map((s) => s.r);
    const quoteSignatureVS = signatures.map((s) => s._vs);
    const validUntil = policyParams.map((pp) => pp.validUntil);
    return [payout, premium, lossProb, expiration, policyData, quoteSignatureR, quoteSignatureVS, validUntil];
  }

  it("ERC4626CashFlowLender init", async () => {
    const { rm, erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    expect(await erc4626cfl.riskModule()).to.equal(rm.address);
    expect(await erc4626cfl.asset()).to.equal(currency.address);
    expect(await erc4626cfl.totalAssets()).to.equal(0);
  });

  it("Should not allow address(0) for the RM and Asset", async () => {
    const { rm, currency } = await helpers.loadFixture(deployPoolFixture);

    const ERC4626CashFlowLender = await hre.ethers.getContractFactory("ERC4626CashFlowLender");
    await expect(
      hre.upgrades.deployProxy(ERC4626CashFlowLender, [hre.ethers.constants.AddressZero, currency.address], {
        kind: "uups",
      })
    ).to.be.revertedWith("ERC4626CashFlowLender: riskModule_ cannot be zero address");

    await expect(
      hre.upgrades.deployProxy(ERC4626CashFlowLender, [rm.address, hre.ethers.constants.AddressZero], {
        kind: "uups",
      })
    ).to.be.revertedWith("ERC4626CashFlowLender: asset_ cannot be zero address");
  });

  it("Only CHANGE_RM_ROLE can change the RM", async () => {
    const { rm, pool, premiumsAccount, erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    const SignedQuoteRiskModule = await hre.ethers.getContractFactory("SignedQuoteRiskModule");
    const newImpl = await SignedQuoteRiskModule.deploy(pool.address, premiumsAccount.address, false);

    expect(await erc4626cfl.riskModule()).to.equal(rm.address);

    await expect(erc4626cfl.connect(anon).setRiskModule(newImpl.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "CHANGE_RM_ROLE")
    );
    await expect(erc4626cfl.connect(changeRm).setRiskModule(hre.ethers.constants.AddressZero)).to.be.revertedWith(
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

  ["newPolicy", "newPolicyFull", "newPolicyPaidByHolder"].map((method) => {
    it(_tn(`Rejects if called by unauthorized user - ${method}`), async () => {
      const { rm, erc4626cfl } = await helpers.loadFixture(deployPoolFixture);
      const policyParams = await defaultPolicyParams({ rmAddress: rm.address, premium: _A(200) });
      const signature = await makeSignedQuote(signer, policyParams);

      await expect(newPolicy(erc4626cfl, anon, policyParams, cust, signature, method)).to.be.revertedWith(
        accessControlMessage(anon.address, null, "POLICY_CREATOR_ROLE")
      );
    });
  });

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
    const SignedQuoteRiskModule = await hre.ethers.getContractFactory("SignedQuoteRiskModule");
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
      "ERC4626CashFlowLender: Not enough balance to withdraw"
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

    tx = await newPolicy(erc4626cfl, creator, policyParams, cust, signature, "newPolicyFull");
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

  it("Creates a policy paid by holder", async () => {
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
      "ERC4626CashFlowLender: Not enough balance to withdraw"
    );
    await expect(erc4626cfl.connect(lp).redeem(_A(100), anon.address, lp.address)).to.be.revertedWith(
      "ERC4626CashFlowLender: Not enough balance to withdraw"
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
});
