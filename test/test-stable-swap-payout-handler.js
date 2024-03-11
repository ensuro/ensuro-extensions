const { expect } = require("chai");
const {
  _W,
  amountFunction,
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

const { Protocols, buildUniswapConfig } = require("@ensuro/swaplibrary/js/utils");
const {
  newPolicy,
  defaultPolicyParams,
  defaultBucketPolicyParams,
  newBucketPolicy,
  keccak256,
} = require("./test-utils");
const { getTransactionEvent } = require("./utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { ethers } = hre;
const { ZeroAddress } = ethers;

describe("StableSwapPayoutHandler", function () {
  let _A;
  let anon, creator, cust, cust2, guardian, lp, lp2, owner, resolver, signer;

  beforeEach(async () => {
    [, lp, lp2, cust, cust2, signer, resolver, creator, anon, owner, guardian] = await ethers.getSigners();

    _A = amountFunction(6);
  });

  async function deployContractsFixture() {
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(500000) },
      [lp, lp2, cust, owner],
      [_A(100000), _A(10000), _A(2000), _A(1000)]
    );

    const usdt = await initCurrency(
      { name: "Test USDT", symbol: "USDT", decimals: 6, initial_supply: _A(50000) },
      [lp2],
      [_A(5000)]
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
    const SignedBucketRiskModule = await ethers.getContractFactory("SignedBucketRiskModule");
    const rm = await addRiskModule(pool, premiumsAccount, SignedBucketRiskModule, {
      ensuroFee: 0.03,
      extraConstructorArgs: [false],
    });

    await accessManager.grantComponentRole(rm, await rm.PRICER_ROLE(), signer);

    // Setup the cfl
    const ERC4626CashFlowLender = await ethers.getContractFactory("ERC4626CashFlowLender");
    const cfl = await hre.upgrades.deployProxy(
      ERC4626CashFlowLender,
      ["CFL", "ensCFL", await ethers.resolveAddress(rm), await ethers.resolveAddress(currency)],
      {
        kind: "uups",
      }
    );

    // Setup permissions on the RM
    await accessManager.grantComponentRole(rm, await rm.RESOLVER_ROLE(), resolver);
    await accessManager.grantComponentRole(rm, await rm.POLICY_CREATOR_ROLE(), cfl);

    // Fund the CFL
    await cfl.grantRole(await cfl.LP_ROLE(), lp);
    await currency.connect(lp).approve(cfl, _A(5000));
    await cfl.connect(lp).deposit(_A(5000), lp);

    // Setup the swap router mock
    const SwapRouterMock = await ethers.getContractFactory("SwapRouterMock");
    const swapRouter = await SwapRouterMock.deploy(guardian);
    await swapRouter.waitForDeployment();
    await usdt.connect(lp2).transfer(swapRouter.target, _A("5000"));
    await swapRouter.setCurrentPrice(currency.target, usdt.target, _A(1));

    // Setup the swap library
    const SwapLibrary = await ethers.getContractFactory("SwapLibrary");
    const library = await SwapLibrary.deploy();

    // Setup the payout handler
    const StableSwapPayoutHandler = await ethers.getContractFactory("StableSwapPayoutHandler", {
      libraries: {
        SwapLibrary: library.target,
      },
    });
    const payoutHandler = await hre.upgrades.deployProxy(
      StableSwapPayoutHandler,
      [
        "Policy NFT USDT",
        "EPOLUSDT",
        await ethers.resolveAddress(cfl),
        buildUniswapConfig(_W("0.02"), _A("0.0005"), swapRouter.target),
      ],
      {
        kind: "uups",
        constructorArgs: [await ethers.resolveAddress(usdt)],
        unsafeAllowLinkedLibraries: true,
      }
    );

    // Setup payout handler permissions
    await cfl.grantRole(await cfl.OWN_POLICY_CREATOR_ROLE(), payoutHandler);
    await payoutHandler.grantRole(await payoutHandler.POLICY_CREATOR_ROLE(), creator);

    return {
      accessManager,
      currency,
      ERC4626CashFlowLender,
      cfl,
      etk,
      pool,
      premiumsAccount,
      rm,
      SignedBucketRiskModule,
      usdt,
      payoutHandler,
      StableSwapPayoutHandler,
    };
  }

  it("StableSwapPayoutHandler init", async () => {
    const { cfl, currency, payoutHandler, usdt } = await helpers.loadFixture(deployContractsFixture);
    expect(await payoutHandler.currency()).to.equal(currency.target);
    expect(await payoutHandler.outStable()).to.equal(usdt.target);
    expect(await payoutHandler.cashflowLender()).to.equal(cfl.target);
  });

  it("Can create policies and assigns them to the end user", async () => {
    const { rm, payoutHandler, pool } = await helpers.loadFixture(deployContractsFixture);
    const policyParams = await defaultBucketPolicyParams({ rm: rm, payout: _A(800), premium: _A(200) });
    const signature = await makeSignedQuote(signer, policyParams, makeBucketQuoteMessage);

    const tx = await payoutHandler
      .connect(creator)
      .newPolicyOnBehalfOf(
        rm.target,
        policyParams.payout,
        policyParams.premium,
        policyParams.lossProb,
        policyParams.expiration,
        cust.address,
        policyParams.bucketId,
        policyParams.policyData,
        signature.r,
        signature.yParityAndS,
        policyParams.validUntil
      );

    const newPolicyEvt = getTransactionEvent(pool.interface, await tx.wait(), "NewPolicy");
    const policyId = newPolicyEvt.args[1].id;

    await expect(tx).to.emit(payoutHandler, "Transfer").withArgs(ZeroAddress, cust, policyId);

    expect(await pool.ownerOf(policyId)).to.equal(payoutHandler);
    expect(await payoutHandler.ownerOf(policyId)).to.equal(cust);
  });

  it("Can create policies in batch and assigns them to the end user", async () => {
    const { rm, payoutHandler, pool } = await helpers.loadFixture(deployContractsFixture);
    const policyParams = await Promise.all([
      defaultBucketPolicyParams({
        rm: rm,
        payout: _A(800),
        premium: _A(100),
        policyData: keccak256("1"),
      }),
      defaultBucketPolicyParams({
        rm: rm,
        payout: _A(900),
        premium: _A(110),
        policyData: keccak256("2"),
      }),
    ]);
    policyParams[0].owner = cust;
    policyParams[1].owner = cust2;

    const signatures = await Promise.all(policyParams.map((p) => makeSignedQuote(signer, p, makeBucketQuoteMessage)));

    const tx = await payoutHandler
      .connect(creator)
      .newPoliciesInBatchOnBehalfOf(...makeBatchParams(policyParams, signatures, rm));

    const newPolicyEvts = getTransactionEvent(pool.interface, await tx.wait(), "NewPolicy", false);

    // 2 policies were created
    expect(newPolicyEvts.length).to.equal(2);

    // Policies are owned by the payout handler
    expect(await pool.ownerOf(newPolicyEvts[0].args[1].id)).to.equal(payoutHandler);
    expect(await pool.ownerOf(newPolicyEvts[1].args[1].id)).to.equal(payoutHandler);

    // Payout handler NFTs are owned by the customers
    expect(await payoutHandler.ownerOf(newPolicyEvts[0].args[1].id)).to.equal(cust);
    expect(await payoutHandler.ownerOf(newPolicyEvts[1].args[1].id)).to.equal(cust2);
  });

  it("Handles policy resolution and sends payout to the user", async () => {
    const { rm, payoutHandler, pool, usdt } = await helpers.loadFixture(deployContractsFixture);
    const policyParams = await defaultBucketPolicyParams({ rm: rm, payout: _A(354), premium: _A(80) });
    const signature = await makeSignedQuote(signer, policyParams, makeBucketQuoteMessage);

    const creationTx = await payoutHandler
      .connect(creator)
      .newPolicyOnBehalfOf(
        rm.target,
        policyParams.payout,
        policyParams.premium,
        policyParams.lossProb,
        policyParams.expiration,
        cust.address,
        policyParams.bucketId,
        policyParams.policyData,
        signature.r,
        signature.yParityAndS,
        policyParams.validUntil
      );

    const newPolicyEvt = getTransactionEvent(pool.interface, await creationTx.wait(), "NewPolicy");

    const resolutionTx = await rm.connect(resolver).resolvePolicy([...newPolicyEvt.args.policy], _A(354));

    await expect(resolutionTx).to.changeTokenBalance(usdt, cust, _A(354));
  });

  it("Burns NFT on policy expiration", async () => {
    const { rm, payoutHandler, pool } = await helpers.loadFixture(deployContractsFixture);
    const policyParams = await defaultBucketPolicyParams({ rm: rm, payout: _A(800), premium: _A(200) });
    const signature = await makeSignedQuote(signer, policyParams, makeBucketQuoteMessage);

    const tx = await payoutHandler
      .connect(creator)
      .newPolicyOnBehalfOf(
        rm.target,
        policyParams.payout,
        policyParams.premium,
        policyParams.lossProb,
        policyParams.expiration,
        cust.address,
        policyParams.bucketId,
        policyParams.policyData,
        signature.r,
        signature.yParityAndS,
        policyParams.validUntil
      );

    const newPolicyEvt = getTransactionEvent(pool.interface, await tx.wait(), "NewPolicy");
    const policyId = newPolicyEvt.args[1].id;

    await helpers.time.increaseTo(newPolicyEvt.args.policy.expiration + 500n);
    await expect(pool.expirePolicy([...newPolicyEvt.args.policy]))
      .to.emit(payoutHandler, "Transfer")
      .withArgs(cust.address, ZeroAddress, policyId);

    expect(await payoutHandler.balanceOf(cust.address)).to.equal(0);
  });
});

function makeBatchParams(policyParams, signatures, rm) {
  const payout = policyParams.map((pp) => pp.payout);
  const premium = policyParams.map((pp) => pp.premium);
  const lossProb = policyParams.map((pp) => pp.lossProb);
  const expiration = policyParams.map((pp) => pp.expiration);
  const policyData = policyParams.map((pp) => pp.policyData);
  const quoteSignatureR = signatures.map((s) => s.r);
  const quoteSignatureVS = signatures.map((s) => s.yParityAndS);
  const validUntil = policyParams.map((pp) => pp.validUntil);
  const bucketId = policyParams.map((pp) => pp.bucketId);
  const riskModules = policyParams.map(() => rm.target);
  const onBehalfOf = policyParams.map((pp) => pp.owner.address);

  return [
    riskModules,
    payout,
    premium,
    lossProb,
    expiration,
    onBehalfOf,
    bucketId,
    policyData,
    quoteSignatureR,
    quoteSignatureVS,
    validUntil,
  ];
}
