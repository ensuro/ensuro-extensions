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

  beforeEach(async () => {
    [__, lp, cust, signer, resolver, creator, anon, owner, guardian, changeRm] = await hre.ethers.getSigners();

    _A = amountFunction(6);
  });

  async function deployPoolFixture(creationIsOpen) {
    creationIsOpen = creationIsOpen === undefined ? true : creationIsOpen;
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(50000) },
      [lp, cust, owner],
      [_A(5000), _A(2000), _A(1000)]
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
    const erc4626cfl = await hre.upgrades.deployProxy(ERC4626CashFlowLender, [rm.address], {
      kind: "uups",
      constructorArgs: [currency.address],
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
      hre.upgrades.deployProxy(ERC4626CashFlowLender, [hre.ethers.constants.AddressZero], {
        kind: "uups",
        constructorArgs: [currency.address],
      })
    ).to.be.revertedWith("ERC4626CashFlowLender: riskModule_ cannot be zero address");

    await expect(
      hre.upgrades.deployProxy(ERC4626CashFlowLender, [rm.address], {
        kind: "uups",
        constructorArgs: [hre.ethers.constants.AddressZero],
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

    expect(await erc4626cfl.riskModule()).to.equal(rm.address);

    await expect(erc4626cfl.connect(changeRm).setRiskModule(newImpl.address))
      .to.emit(erc4626cfl, "RiskModuleChanged")
      .withArgs(newImpl.address);

    expect(await erc4626cfl.riskModule()).to.equal(newImpl.address);
  });

  it("Creates a policy paid by the ERC4626CashFlowLender", async () => {
    const { rm, pool, currency, erc4626cfl } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address, premium: _A(200) });
    const quoteMessage = makeQuoteMessage(policyParams);
    const signature = ethers.utils.splitSignature(await signer.signMessage(ethers.utils.arrayify(quoteMessage)));
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

    await erc4626cfl.connect(resolver).resolvePolicy(newPolicyEvt.args[1], _A(800));
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200) - _A(800)); // 200 prev debt - 800 payout

    // await expect(erc4626cfl.connect(lp).withdraw(_A(100), anon.address, lp.address)).to.be.revertedWith(
    //   "ERC4626CashFlowLender: cannot withdraw if there's debt with the customer"
    // );
  });

  it("Rejects if called by unauthorized user", async () => {
    const { rm, erc4626cfl } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address, premium: _A(200) });
    const signature = await makeSignedQuote(signer, policyParams);

    await expect(newPolicy(erc4626cfl, anon, policyParams, cust, signature)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "POLICY_CREATOR_ROLE")
    );
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

    await currency.connect(owner).transfer(erc4626cfl.address, _A(1000));
    let tx = await newPolicy(erc4626cfl, creator, policyParams, cust, signature);
    let receipt = await tx.wait();
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200));
    let newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    //
    await helpers.time.increaseTo(newPolicyEvt.args[1].expiration + 500);
    // Expire the policy
    await expect(pool.expirePolicy(newPolicyEvt.args[1])).not.to.emit(erc4626cfl, "DebtChanged");
    expect(await erc4626cfl.currentDebt()).to.be.equal(_A(200));

    // Withdraw the funds
    // await expect(erc4626cfl.connect(cust).withdraw(_A(1000), anon.address, cust.address)).to.be.revertedWith(
    //   "ERC4626CashFlowLender: not enough assets to withdraw"
    // );
    // await expect(erc4626cfl.connect(cust).withdraw(_A(200), anon.address, cust.address))
    //   .to.emit(erc4626cfl, "Withdrawal")
    //   .withArgs(anon.address, _A(200));
    // expect(await currency.balanceOf(erc4626cfl.address)).to.be.equal(_A(600));
    // expect(await erc4626cfl.currentDebt()).to.be.equal(_A(0));
  });

  it("Address without LP_ROLE can't deposit/mint", async () => {
    const { erc4626cfl, currency } = await helpers.loadFixture(deployPoolFixture);

    await currency.connect(cust).transfer(erc4626cfl.address, _A(800));
    await expect(erc4626cfl.connect(anon).deposit(_A(800), erc4626cfl.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "LP_ROLE")
    );

    await expect(erc4626cfl.connect(anon).mint(_A(800), erc4626cfl.address)).to.be.revertedWith(
      accessControlMessage(anon.address, null, "LP_ROLE")
    );
  });
});
