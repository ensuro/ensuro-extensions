const { expect } = require("chai");
const {
  _W,
  amountFunction,
  getTransactionEvent,
  accessControlMessage,
  makeQuoteMessage,
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
const { MaxUint256, ZeroAddress } = ethers;

describe("CashFlowLender contract tests", function () {
  let _A;
  let anon, creator, cust, guardian, lp, owner, resolver, signer;

  beforeEach(async () => {
    [, lp, cust, signer, resolver, creator, anon, owner, guardian] = await ethers.getSigners();

    _A = amountFunction(6);
  });

  async function deployPoolFixture(creationIsOpen) {
    creationIsOpen = creationIsOpen === undefined ? true : creationIsOpen;
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(50000) },
      [lp, cust, owner],
      [_A(5000), _A(500), _A(1000)]
    );

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

    await accessManager.grantComponentRole(rm, await rm.PRICER_ROLE(), signer);

    return { etk, premiumsAccount, rm, pool, accessManager, currency, SignedQuoteRiskModule };
  }

  async function deployPoolAndCFLFixture(creationIsOpen, contractClass = "CashFlowLender") {
    const { rm, accessManager, ...others } = await deployPoolFixture(creationIsOpen);
    const CashFlowLender = await ethers.getContractFactory(contractClass);
    const rmAddr = await ethers.resolveAddress(rm);
    const custAddr = await ethers.resolveAddress(cust);
    const cfLender = await hre.upgrades.deployProxy(CashFlowLender, [custAddr], {
      kind: "uups",
      constructorArgs: [rmAddr],
    });
    creationIsOpen = creationIsOpen === undefined ? true : creationIsOpen;

    if (!creationIsOpen) await accessManager.grantComponentRole(rm, await rm.POLICY_CREATOR_ROLE(), cfLender);
    await accessManager.grantComponentRole(rm, await rm.RESOLVER_ROLE(), cfLender);
    await cfLender.grantRole(await cfLender.OWNER_ROLE(), owner);
    await cfLender.grantRole(await cfLender.RESOLVER_ROLE(), resolver);
    await cfLender.grantRole(await cfLender.POLICY_CREATOR_ROLE(), creator);
    await cfLender.grantRole(await cfLender.GUARDIAN_ROLE(), guardian);
    return { rm, accessManager, cfLender, ...others };
  }

  function deployPoolAndCFLFixtureCreationClosed() {
    return deployPoolAndCFLFixture(false);
  }

  function deployPoolAndCFLFixtureMultiRMCashFlowLender() {
    return deployPoolAndCFLFixture(true, "MultiRMCashFlowLender");
  }

  async function deployPoolAndCFLFixtureUpgradeToMultiRM() {
    const { cfLender, rm, ...others } = await deployPoolAndCFLFixture();
    const MultiRMCashFlowLender = await ethers.getContractFactory("MultiRMCashFlowLender");
    const newImpl = await MultiRMCashFlowLender.deploy(rm);
    await expect(cfLender.connect(anon).upgradeTo(newImpl)).to.be.revertedWith(
      accessControlMessage(anon, null, "GUARDIAN_ROLE")
    );
    await cfLender.connect(guardian).upgradeTo(newImpl);
    return { cfLender, rm, ...others };
  }

  async function deployPoolAndCFLFixtureUpgradeToMultiRMChangeRM() {
    let { cfLender, rm, SignedQuoteRiskModule, pool, premiumsAccount, accessManager, ...others } =
      await deployPoolAndCFLFixtureUpgradeToMultiRM();
    // Bind cfLender variable with the MultiRMCashFlowLender ABI
    cfLender = await ethers.getContractAt("MultiRMCashFlowLender", cfLender);
    const origRM = rm;
    // Setup a new risk module
    rm = await addRiskModule(pool, premiumsAccount, SignedQuoteRiskModule, {
      ensuroFee: 0.03,
      extraConstructorArgs: [true],
    });

    await accessManager.grantComponentRole(rm, await rm.PRICER_ROLE(), signer);
    await accessManager.grantComponentRole(rm, await rm.RESOLVER_ROLE(), cfLender);
    await cfLender.grantRole(await cfLender.ACTIVE_RM_ADMIN_ROLE(), owner);
    await cfLender.connect(owner).setActiveRiskModule(rm);

    return { cfLender, rm, pool, premiumsAccount, SignedQuoteRiskModule, accessManager, origRM, ...others };
  }

  async function deployPoolAndERC4626CFLFixture() {
    const { rm, accessManager, currency, ...others } = await deployPoolFixture();
    const ERC4626CashFlowLender = await ethers.getContractFactory("ERC4626CashFlowLender");
    const rmAddr = await ethers.resolveAddress(rm);
    const currencyAddr = await ethers.resolveAddress(currency);
    const cfLender = await hre.upgrades.deployProxy(ERC4626CashFlowLender, ["CFL", "ensCFL", rmAddr, currencyAddr], {
      kind: "uups",
    });

    await accessManager.grantComponentRole(rm, await rm.RESOLVER_ROLE(), cfLender);
    await accessManager.grantComponentRole(rm, await rm.PRICER_ROLE(), cfLender);
    await cfLender.grantRole(await cfLender.LP_ROLE(), lp);
    await cfLender.grantRole(await cfLender.CUSTOMER_ROLE(), cust);
    await cfLender.grantRole(await cfLender.RESOLVER_ROLE(), resolver);
    await cfLender.grantRole(await cfLender.POLICY_CREATOR_ROLE(), creator);
    await cfLender.grantRole(await cfLender.GUARDIAN_ROLE(), guardian);

    return { rm, accessManager, currency, cfLender, ...others };
  }

  const variants = [
    { name: "CFL", fixture: deployPoolAndCFLFixture },
    { name: "CFL creationIsClosed", fixture: deployPoolAndCFLFixtureCreationClosed },
    { name: "MultiRMCashFlowLender", fixture: deployPoolAndCFLFixtureMultiRMCashFlowLender },
    { name: "MultiRMCashFlowLender - Upgraded", fixture: deployPoolAndCFLFixtureUpgradeToMultiRM },
    { name: "MultiRMCashFlowLender - RM Changed", fixture: deployPoolAndCFLFixtureUpgradeToMultiRMChangeRM },
  ];

  // eslint-disable-next-line array-callback-return
  variants.map((variant) => {
    // eslint-disable-next-line func-style
    const _tn = (testName) => `${testName} - ${variant.name}`;

    it(_tn("Creates a policy paid by the CashFlowLender"), async () => {
      const { rm, pool, currency, cfLender } = await helpers.loadFixture(variant.fixture);
      const policyParams = await defaultPolicyParams({ rm: rm, premium: _A(200) });
      const quoteMessage = makeQuoteMessage(policyParams);
      const signature = ethers.Signature.from(await signer.signMessage(ethers.getBytes(quoteMessage)));
      await expect(newPolicy(cfLender, creator, policyParams, cust, signature)).to.be.revertedWith(
        "ERC20: transfer amount exceeds balance" // No funds in cfLender
      );
      expect(await currency.balanceOf(cfLender)).to.be.equal(_A(0));
      await currency.connect(owner).transfer(cfLender, _A(1000));
      const tx = await newPolicy(cfLender, creator, policyParams, cust, signature);
      const receipt = await tx.wait();
      expect(await currency.balanceOf(cfLender)).to.be.equal(_A(800)); // 200 spent on the premium
      expect(await cfLender.currentDebt()).to.be.equal(_A(200));
      const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
      const policyId = newPolicyEvt.args[1].id;
      expect(await pool.ownerOf(policyId)).to.be.equal(cfLender);

      await cfLender.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], _A(800));
      expect(await cfLender.currentDebt()).to.be.equal(_A(0));
      expect(await currency.balanceOf(cfLender)).to.be.equal(_A(1000)); // 200 debt repaid
      expect(await currency.balanceOf(cust)).to.be.equal(_A(500 + 600)); // 500 initial + 600 (800-200)
    });

    it(_tn("Creates policies in batch paid by the CashFlowLender"), async () => {
      const { rm, pool, currency, cfLender } = await helpers.loadFixture(variant.fixture);
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
        cfLender.connect(anon).newPoliciesInBatch(...makeBatchParams(policyParams, signatures))
      ).to.be.revertedWith(accessControlMessage(anon, null, "POLICY_CREATOR_ROLE"));

      await expect(
        cfLender.connect(creator).newPoliciesInBatch(...makeBatchParams(policyParams, signatures))
      ).to.be.revertedWith("ERC20: transfer amount exceeds balance");

      expect(await currency.balanceOf(cfLender)).to.be.equal(_A(0));

      // Transfer some money, not enough to cover all the premiums
      await currency.connect(owner).transfer(cfLender, _A(300));

      await expect(
        cfLender.connect(creator).newPoliciesInBatch(...makeBatchParams(policyParams, signatures))
      ).to.be.revertedWith("ERC20: transfer amount exceeds balance");

      expect(await currency.balanceOf(cfLender)).to.be.equal(_A(300));

      await currency.connect(owner).transfer(cfLender, _A(500));

      const tx = await cfLender.connect(creator).newPoliciesInBatch(...makeBatchParams(policyParams, signatures));
      const receipt = await tx.wait();
      expect(await currency.balanceOf(cfLender)).to.be.equal(_A(200)); // 600 spent on the premium
      expect(await cfLender.currentDebt()).to.be.equal(_A(600));
      const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
      const policyId = newPolicyEvt.args[1].id;
      expect(await pool.ownerOf(policyId)).to.be.equal(cfLender);

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
      expect(await pool.ownerOf(newPolicyEvts[1].args[1].id)).to.be.equal(cfLender);
      expect(await pool.ownerOf(newPolicyEvts[2].args[1].id)).to.be.equal(cfLender);

      await cfLender.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], _A(800));
      expect(await cfLender.currentDebt()).to.be.equal(_A(0));
      expect(await currency.balanceOf(cfLender)).to.be.equal(_A(200 + 600)); // 600 debt repaid
      expect(await currency.balanceOf(cust)).to.be.equal(_A(500 + 800 - 600)); // 500 initial + 600 (800-600)
    });

    ["newPolicy", "newPolicyFull", "newPolicyPaidByHolder"].map((method) =>
      it(_tn(`Rejects if called by unauthorized user - ${method}`), async () => {
        const { rm, cfLender } = await helpers.loadFixture(variant.fixture);
        const policyParams = await defaultPolicyParams({ rm: rm, premium: _A(200) });
        const quoteMessage = makeQuoteMessage(policyParams);
        const signature = ethers.Signature.from(await signer.signMessage(ethers.getBytes(quoteMessage)));
        await expect(newPolicy(cfLender, anon, policyParams, cust, signature, method)).to.be.revertedWith(
          accessControlMessage(anon, null, "POLICY_CREATOR_ROLE")
        );
      })
    );

    it(_tn("Rejects if resolved by unauthorized user"), async () => {
      const { rm, currency, pool, cfLender } = await helpers.loadFixture(variant.fixture);
      const policyParams = await defaultPolicyParams({ rm: rm, premium: _A(200) });
      const quoteMessage = makeQuoteMessage(policyParams);
      const signature = ethers.Signature.from(await signer.signMessage(ethers.getBytes(quoteMessage)));
      await currency.connect(owner).transfer(cfLender, _A(1000));
      const tx = await newPolicy(cfLender, creator, policyParams, cust, signature);
      const receipt = await tx.wait();
      expect(await currency.balanceOf(cfLender)).to.be.equal(_A(800)); // 200 spent on the premium
      expect(await cfLender.currentDebt()).to.be.equal(_A(200));
      const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
      await expect(cfLender.connect(anon).resolvePolicy([...newPolicyEvt.args[1]], _A(800))).to.be.revertedWith(
        accessControlMessage(anon, null, "RESOLVER_ROLE")
      );
    });

    it(_tn("Test no payout to customer because outstanding debt"), async () => {
      const { rm, pool, currency, cfLender } = await helpers.loadFixture(variant.fixture);
      let policyParams = await defaultPolicyParams({ rm: rm, premium: _A(200) });
      let quoteMessage = makeQuoteMessage(policyParams);
      let signature = ethers.Signature.from(await signer.signMessage(ethers.getBytes(quoteMessage)));
      await currency.connect(owner).transfer(cfLender, _A(1000));
      let tx = await newPolicy(cfLender, creator, policyParams, cust, signature);
      let receipt = await tx.wait();
      expect(await cfLender.currentDebt()).to.be.equal(_A(200));
      let newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
      await expect(cfLender.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], _A(150)))
        .to.emit(cfLender, "DebtChanged")
        .withArgs(_A(50));
      expect(await cfLender.currentDebt()).to.be.equal(_A(50));
      expect(await currency.balanceOf(cust)).to.be.equal(_A(500)); // 500 initial

      // 2nd Policy
      policyParams = await defaultPolicyParams({
        rm: rm,
        premium: _A(100),
        payout: _A(500),
        policyData: "0x2cbef6744ebcff4969e06c41631a1d0aa71366c4fd997e9ff5a59b8efa9b9032",
      });
      quoteMessage = makeQuoteMessage(policyParams);
      signature = ethers.Signature.from(await signer.signMessage(ethers.getBytes(quoteMessage)));
      tx = await newPolicy(cfLender, creator, policyParams, cust, signature, "newPolicyFull");
      receipt = await tx.wait();
      expect(await cfLender.currentDebt()).to.be.equal(_A(150));
      newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

      await expect(cfLender.connect(anon).resolvePolicyFullPayout([...newPolicyEvt.args[1]], true)).to.be.revertedWith(
        accessControlMessage(anon, null, "RESOLVER_ROLE")
      );

      await expect(cfLender.connect(resolver).resolvePolicyFullPayout([...newPolicyEvt.args[1]], true))
        .to.emit(cfLender, "DebtChanged")
        .withArgs(_A(0));
      expect(await currency.balanceOf(cust)).to.be.equal(_A(500 + 500 - 150));
    });

    it(_tn("Repay debt then payout goes to customer"), async () => {
      const { rm, pool, currency, cfLender } = await helpers.loadFixture(variant.fixture);
      let policyParams = await defaultPolicyParams({ rm: rm, premium: _A(200) });
      let quoteMessage = makeQuoteMessage(policyParams);
      let signature = ethers.Signature.from(await signer.signMessage(ethers.getBytes(quoteMessage)));
      await currency.connect(owner).transfer(cfLender, _A(1000));
      let tx = await newPolicy(cfLender, creator, policyParams, cust, signature);
      let receipt = await tx.wait();
      expect(await cfLender.currentDebt()).to.be.equal(_A(200));
      let newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
      // Repay debt
      await currency.connect(cust).approve(cfLender, _A(500));
      await expect(cfLender.connect(cust).repayDebt(_A(500)))
        .to.emit(cfLender, "DebtChanged")
        .withArgs(_A(0));
      expect(await cfLender.currentDebt()).to.be.equal(_A(0));
      expect(await currency.balanceOf(cust)).to.be.equal(_A(300)); // 500 initial - 200 repaid
      await expect(cfLender.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], _A(150))).not.to.emit(
        cfLender,
        "DebtChanged"
      );
      expect(await currency.balanceOf(cust)).to.be.equal(_A(450));
    });

    it(_tn("Repay debt works even if resolved through RM directly"), async () => {
      const { rm, pool, currency, cfLender, accessManager } = await helpers.loadFixture(variant.fixture);
      let policyParams = await defaultPolicyParams({ rm: rm, premium: _A(200) });
      let quoteMessage = makeQuoteMessage(policyParams);
      let signature = ethers.Signature.from(await signer.signMessage(ethers.getBytes(quoteMessage)));
      await currency.connect(owner).transfer(cfLender, _A(1000));
      let tx = await newPolicy(cfLender, creator, policyParams, cust, signature);
      let receipt = await tx.wait();
      expect(await cfLender.currentDebt()).to.be.equal(_A(200));
      let newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
      // Resolve with cust address
      await accessManager.grantComponentRole(rm, await rm.RESOLVER_ROLE(), resolver);
      await expect(rm.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], _A(250)))
        .to.emit(cfLender, "DebtChanged")
        .withArgs(_A(0));
      expect(await currency.balanceOf(cust)).to.be.equal(_A(550));
      expect(await cfLender.riskModule()).to.be.equal(rm);
    });

    it(_tn("Checks policy expires OK"), async () => {
      const { rm, pool, currency, cfLender } = await helpers.loadFixture(variant.fixture);
      let policyParams = await defaultPolicyParams({ rm: rm, premium: _A(200) });
      let quoteMessage = makeQuoteMessage(policyParams);
      let signature = ethers.Signature.from(await signer.signMessage(ethers.getBytes(quoteMessage)));
      await currency.connect(owner).transfer(cfLender, _A(1000));
      let tx = await newPolicy(cfLender, creator, policyParams, cust, signature);
      let receipt = await tx.wait();
      expect(await cfLender.currentDebt()).to.be.equal(_A(200));
      let newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
      //
      await helpers.time.increaseTo(newPolicyEvt.args[1].expiration + 500n);
      // Expire the policy
      await expect(pool.expirePolicy([...newPolicyEvt.args[1]])).not.to.emit(cfLender, "DebtChanged");
      expect(await cfLender.currentDebt()).to.be.equal(_A(200));
    });

    it(_tn("It's possible to change the customer address and other receives the payout"), async () => {
      const { rm, pool, currency, cfLender } = await helpers.loadFixture(variant.fixture);
      let policyParams = await defaultPolicyParams({ rm: rm, premium: _A(200) });
      let quoteMessage = makeQuoteMessage(policyParams);
      let signature = ethers.Signature.from(await signer.signMessage(ethers.getBytes(quoteMessage)));
      await currency.connect(owner).transfer(cfLender, _A(1000));
      let tx = await newPolicy(cfLender, creator, policyParams, cust, signature);
      let receipt = await tx.wait();
      expect(await cfLender.currentDebt()).to.be.equal(_A(200));
      let newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

      // Try changing the customer with anon
      await expect(cfLender.connect(anon).setCustomer(anon)).to.be.revertedWith(
        accessControlMessage(anon, null, "OWNER_ROLE")
      );
      await expect(cfLender.connect(owner).setCustomer(anon)).to.emit(cfLender, "CustomerChanged").withArgs(anon);
      expect(await cfLender.customer()).to.be.equal(anon);
      await expect(cfLender.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], _A(500)))
        .to.emit(cfLender, "DebtChanged")
        .withArgs(_W(0));
      expect(await currency.balanceOf(cust)).to.be.equal(_A(500)); // unchanged
      expect(await currency.balanceOf(anon)).to.be.equal(_A(300)); // 500 payout - 200 debt
    });

    it(_tn("Test only the owner can withdraw the funds"), async () => {
      const { rm, pool, currency, cfLender } = await helpers.loadFixture(variant.fixture);
      let policyParams = await defaultPolicyParams({ rm: rm, premium: _A(200) });
      let quoteMessage = makeQuoteMessage(policyParams);
      let signature = ethers.Signature.from(await signer.signMessage(ethers.getBytes(quoteMessage)));
      await currency.connect(owner).transfer(cfLender, _A(1000));
      let tx = await newPolicy(cfLender, creator, policyParams, cust, signature, "newPolicyPaidByHolder");
      let receipt = await tx.wait();
      expect(await cfLender.currentDebt()).to.be.equal(_A(200));
      let newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

      // Try changing the customer with anon
      await expect(cfLender.connect(anon).withdraw(_A(200), anon)).to.be.revertedWith(
        accessControlMessage(anon, null, "OWNER_ROLE")
      );
      await expect(cfLender.connect(owner).withdraw(_A(300), anon))
        .to.emit(cfLender, "Withdrawal")
        .withArgs(anon, _A(300));
      expect(await currency.balanceOf(anon)).to.be.equal(_A(300));
      expect(await currency.balanceOf(cfLender)).to.be.equal(_A(1000 - 300 - 200));
      await expect(cfLender.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], _A(200)))
        .to.emit(cfLender, "DebtChanged")
        .withArgs(_A(0));
      await expect(cfLender.connect(owner).withdraw(MaxUint256, anon))
        .to.emit(cfLender, "Withdrawal")
        .withArgs(anon, _A(700));
      expect(await currency.balanceOf(anon)).to.be.equal(_A(1000));
      expect(await currency.balanceOf(cfLender)).to.be.equal(_A(0));
      // When no more funds, withdraw doesn't fails, just doesn't do anything
      await expect(cfLender.connect(owner).withdraw(MaxUint256, anon)).not.to.emit(cfLender, "Withdrawal");
    });
  });

  const allCFLs = variants.concat([{ name: "ERC4626CashFlowLender", fixture: deployPoolAndERC4626CFLFixture }]);

  // eslint-disable-next-line array-callback-return
  allCFLs.map((variant) => {
    // eslint-disable-next-line func-style
    const _tn = (testName) => `${testName} - ${variant.name}`;

    it(_tn("Only policy pool can call onPayoutReceived"), async () => {
      const { rm, pool, currency, cfLender } = await helpers.loadFixture(variant.fixture);
      let policyParams = await defaultPolicyParams({ rm: rm, premium: _A(200) });
      let quoteMessage = makeQuoteMessage(policyParams);
      let signature = ethers.Signature.from(await signer.signMessage(ethers.getBytes(quoteMessage)));
      await currency.connect(owner).transfer(cfLender, _A(1000));

      const tx = await newPolicy(cfLender, creator, policyParams, cust, signature);
      const receipt = await tx.wait();
      const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
      const policyId = newPolicyEvt.args[1].id;

      await expect(cfLender.connect(owner).onPayoutReceived(owner, pool, policyId, _A(800))).to.be.revertedWith(
        "Only the PolicyPool should call this method"
      );
    });

    it(_tn("Resolve policy from RM"), async () => {
      const { rm, pool, accessManager, currency, cfLender } = await helpers.loadFixture(variant.fixture);
      let policyParams = await defaultPolicyParams({ rm: rm, premium: _A(200) });
      let quoteMessage = makeQuoteMessage(policyParams);
      let signature = ethers.Signature.from(await signer.signMessage(ethers.getBytes(quoteMessage)));

      await currency.connect(owner).transfer(cfLender, _A(1000));
      const tx = await newPolicy(cfLender, creator, policyParams, cust, signature);
      const receipt = await tx.wait();
      expect(await currency.balanceOf(cfLender)).to.be.equal(_A(800)); // 200 spent on the premium
      expect(await cfLender.currentDebt()).to.be.equal(_A(200));

      const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
      const policyId = newPolicyEvt.args[1].id;
      expect(await pool.ownerOf(policyId)).to.be.equal(cfLender);

      await accessManager.grantComponentRole(rm, await rm.RESOLVER_ROLE(), resolver);

      await rm.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], _A(800));
      if (variant.name === "ERC4626CashFlowLender") {
        expect(await cfLender.currentDebt()).to.be.equal(_A(200) - _A(800)); // 200 prev debt - 800 payout
      } else {
        expect(await cfLender.currentDebt()).to.be.equal(_A(0));
      }
    });
  });

  it("Creates a policy paid by the MultiRMCashFlowLender with two different RMs", async () => {
    const { rm, pool, currency, cfLender, premiumsAccount, SignedQuoteRiskModule, accessManager } =
      await helpers.loadFixture(deployPoolAndCFLFixtureMultiRMCashFlowLender);
    // Fund the CFL
    await currency.connect(owner).transfer(cfLender, _A(1000));
    // Create a policy with the first RM
    const policyParams = await defaultPolicyParams({ rm: rm, premium: _A(200) });
    const quoteMessage = makeQuoteMessage(policyParams);
    const signature = ethers.Signature.from(await signer.signMessage(ethers.getBytes(quoteMessage)));
    const tx = await newPolicy(cfLender, creator, policyParams, cust, signature);
    const receipt = await tx.wait();
    expect(await currency.balanceOf(cfLender)).to.be.equal(_A(800)); // 200 spent on the premium
    expect(await cfLender.currentDebt()).to.be.equal(_A(200));
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const policyId = newPolicyEvt.args[1].id;
    expect(await pool.ownerOf(policyId)).to.be.equal(cfLender);

    // Setup a new risk module
    const newRM = await addRiskModule(pool, premiumsAccount, SignedQuoteRiskModule, {
      ensuroFee: 0.03,
      extraConstructorArgs: [true],
    });

    expect(await cfLender.connect(owner).riskModule()).to.be.equal(rm);
    await accessManager.grantComponentRole(newRM, await newRM.PRICER_ROLE(), signer);
    await accessManager.grantComponentRole(newRM, await newRM.RESOLVER_ROLE(), cfLender);
    await cfLender.grantRole(await cfLender.ACTIVE_RM_ADMIN_ROLE(), owner);
    await expect(cfLender.connect(owner).setActiveRiskModule(newRM))
      .to.emit(cfLender, "ActiveRiskModuleChanged")
      .withArgs(newRM);
    expect(await cfLender.connect(owner).riskModule()).to.be.equal(newRM);

    // Create a policy with the new RM
    const policyParams2 = await defaultPolicyParams({ rm: newRM, premium: _A(150) });
    const quoteMessage2 = makeQuoteMessage(policyParams2);
    const signature2 = ethers.Signature.from(await signer.signMessage(ethers.getBytes(quoteMessage2)));
    const tx2 = await newPolicy(cfLender, creator, policyParams2, cust, signature2);
    const receipt2 = await tx2.wait();
    expect(await currency.balanceOf(cfLender)).to.be.equal(_A(650)); // 200+150 spent on the premium
    expect(await cfLender.currentDebt()).to.be.equal(_A(350));
    const newPolicyEvt2 = getTransactionEvent(pool.interface, receipt2, "NewPolicy");
    expect(newPolicyEvt2.args[0]).to.be.equal(newRM); // Check was created in the new RM
    const policyId2 = newPolicyEvt2.args[1].id;
    expect(await pool.ownerOf(policyId2)).to.be.equal(cfLender);

    // Resolve 1st policy, works fine
    await cfLender.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], _A(300));
    expect(await cfLender.currentDebt()).to.be.equal(_A(50)); // 350 - 300
    expect(await currency.balanceOf(cfLender)).to.be.equal(_A(950)); // debt partially repaid
    expect(await currency.balanceOf(cust)).to.be.equal(_A(500)); // 500 initial unchanged

    // Resolve 2nd policy, works fine too
    await cfLender.connect(resolver).resolvePolicy([...newPolicyEvt2.args[1]], _A(500));
    expect(await cfLender.currentDebt()).to.be.equal(_A(0));
    expect(await currency.balanceOf(cfLender)).to.be.equal(_A(1000)); // debt fully repaid
    expect(await currency.balanceOf(cust)).to.be.equal(_A(500 + 450)); // 500 initial + 450 (500-50)
  });

  it("MultiRMCashFlowLender.setActiveRiskModule make sure pool unchanged", async () => {
    const { rm, pool, cfLender, premiumsAccount, SignedQuoteRiskModule } = await helpers.loadFixture(
      deployPoolAndCFLFixtureMultiRMCashFlowLender
    );

    expect(await cfLender.connect(owner).riskModule()).to.be.equal(rm);

    const otherPoolSetup = await deployPoolFixture(true);
    expect(pool).not.to.be.equal(otherPoolSetup.pool);

    await expect(cfLender.connect(anon).setActiveRiskModule(otherPoolSetup.rm)).to.be.revertedWith(
      accessControlMessage(anon, null, "ACTIVE_RM_ADMIN_ROLE")
    );

    await cfLender.grantRole(await cfLender.ACTIVE_RM_ADMIN_ROLE(), owner);

    await expect(cfLender.connect(owner).setActiveRiskModule(otherPoolSetup.rm)).to.be.revertedWith(
      "The new risk module has to be part of the same pool"
    );

    // Setup a new risk module
    const newRM = await addRiskModule(pool, premiumsAccount, SignedQuoteRiskModule, {
      ensuroFee: 0.03,
      extraConstructorArgs: [true],
    });

    await expect(cfLender.connect(owner).setActiveRiskModule(newRM))
      .to.emit(cfLender, "ActiveRiskModuleChanged")
      .withArgs(newRM);
    expect(await cfLender.connect(owner).riskModule()).to.be.equal(newRM);

    // Setting back address(0) is also possible, then goes back to original RM
    await expect(cfLender.connect(owner).setActiveRiskModule(ZeroAddress))
      .to.emit(cfLender, "ActiveRiskModuleChanged")
      .withArgs(rm);
    expect(await cfLender.connect(owner).riskModule()).to.be.equal(rm);
  });
});
