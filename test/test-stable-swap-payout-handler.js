const { expect } = require("chai");
const {
  _W,
  amountFunction,
  accessControlMessage,
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
const { defaultBucketPolicyParams, keccak256, getAddress } = require("./test-utils");
const { getTransactionEvent } = require("./utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { ethers } = hre;
const { ZeroAddress, ZeroHash } = ethers;

describe("StableSwapPayoutHandler", function () {
  let _A;
  let anon, creator, cust, cust2, guardian, lp, lp2, policyPricer, resolver, usdtPricer;

  beforeEach(async () => {
    [, lp, lp2, cust, cust2, policyPricer, resolver, creator, anon, usdtPricer, guardian] = await ethers.getSigners();

    _A = amountFunction(6);
  });

  async function deployContractsFixture() {
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(500000) },
      [lp, lp2, cust, usdtPricer],
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
    await accessManager.grantComponentRole(rm, await rm.PRICER_ROLE(), policyPricer);
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
    await usdt.connect(lp2).transfer(swapRouter, _A("5000"));
    await swapRouter.setCurrentPrice(currency, usdt, _A(1));

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
        _W("1"), // swap price
        guardian.address,
      ],
      {
        kind: "uups",
        constructorArgs: [await ethers.resolveAddress(usdt)],
        unsafeAllowLinkedLibraries: true,
      }
    );

    // Setup payout handler permissions
    await cfl.grantRole(await cfl.OWN_POLICY_CREATOR_ROLE(), payoutHandler);
    await payoutHandler.connect(guardian).grantRole(await payoutHandler.GUARDIAN_ROLE(), guardian);
    await payoutHandler.connect(guardian).grantRole(await payoutHandler.POLICY_CREATOR_ROLE(), creator);
    await payoutHandler.connect(guardian).grantRole(await payoutHandler.SWAP_PRICER_ROLE(), usdtPricer);

    return {
      accessManager,
      cfl,
      currency,
      ERC4626CashFlowLender,
      etk,
      payoutHandler,
      pool,
      premiumsAccount,
      rm,
      SignedBucketRiskModule,
      StableSwapPayoutHandler,
      swapRouter,
      usdt,
    };
  }

  it("StableSwapPayoutHandler init", async () => {
    const { cfl, currency, payoutHandler, usdt, swapRouter } = await helpers.loadFixture(deployContractsFixture);
    expect(await payoutHandler.currency()).to.equal(currency.target);
    expect(await payoutHandler.outStable()).to.equal(usdt.target);
    expect(await payoutHandler.cashflowLender()).to.equal(cfl.target);
    expect(await payoutHandler.swapPrice()).to.equal(_W(1));

    const swapConfig = await payoutHandler.swapConfig();
    expect(swapConfig.length).to.equal(3);
    expect(swapConfig[0]).to.equal(Protocols.uniswap);
    expect(swapConfig[1]).to.equal(_W("0.02"));
    expect(swapConfig[2]).to.equal(
      ethers.AbiCoder.defaultAbiCoder().encode(["uint24", "address"], [_A("0.0005"), swapRouter.target])
    );
  });

  it("Implements the IPolicyHolder interface and validates it's called from the policy pool", async () => {
    const { payoutHandler } = await helpers.loadFixture(deployContractsFixture);
    // expect(await payoutHandler.supportsInterface("???")).to.be.true();

    await expect(
      payoutHandler.connect(anon).onERC721Received(anon.address, anon.address, 1n, ZeroHash)
    ).to.be.revertedWith("StableSwapPayoutHandler: The caller must be the PolicyPool");

    await expect(payoutHandler.connect(anon).onPayoutReceived(anon.address, anon.address, 1n, 1n)).to.be.revertedWith(
      "StableSwapPayoutHandler: The caller must be the PolicyPool"
    );

    await expect(payoutHandler.connect(anon).onPolicyExpired(anon.address, anon.address, 1n)).to.be.revertedWith(
      "StableSwapPayoutHandler: The caller must be the PolicyPool"
    );
  });

  it("Only allows SWAP_PRICER_ROLE to set the swap price and validates it", async () => {
    const { payoutHandler } = await helpers.loadFixture(deployContractsFixture);

    const newPrice = _W(1.5);

    await expect(payoutHandler.connect(anon).setSwapPrice(newPrice)).to.be.revertedWith(
      accessControlMessage(anon, null, "SWAP_PRICER_ROLE")
    );

    await expect(payoutHandler.connect(usdtPricer).setSwapPrice(newPrice))
      .to.emit(payoutHandler, "SwapPriceChanged")
      .withArgs(newPrice);
    expect(await payoutHandler.swapPrice()).to.equal(newPrice);

    await expect(payoutHandler.connect(usdtPricer).setSwapPrice(0n)).to.be.revertedWith(
      "StableSwapPayoutHandler: newPrice must be greater than 0"
    );
  });

  it("Only allows POLICY_CREATOR_ROLE to create policies", async () => {
    const { rm, payoutHandler } = await helpers.loadFixture(deployContractsFixture);
    const policyParams = await defaultBucketPolicyParams({ rm: rm, payout: _A(800), premium: _A(200) });
    policyParams.owner = cust;
    const signature = await makeSignedQuote(policyPricer, policyParams, makeBucketQuoteMessage);

    await expect(
      payoutHandler.connect(anon).newPolicyOnBehalfOf(...makeNewPolicyParams(policyParams, signature, rm))
    ).to.be.revertedWith(accessControlMessage(anon, null, "POLICY_CREATOR_ROLE"));

    await expect(
      payoutHandler.connect(anon).newPoliciesInBatchOnBehalfOf(...makeBatchParams([policyParams], [signature], rm))
    ).to.be.revertedWith(accessControlMessage(anon, null, "POLICY_CREATOR_ROLE"));
  });

  it("Constructor and init validations", async () => {
    const { payoutHandler, StableSwapPayoutHandler, cfl, swapRouter } =
      await helpers.loadFixture(deployContractsFixture);

    // Initializers are disabled
    await expect(
      payoutHandler
        .connect(anon)
        .initialize(
          "aName",
          "aSymbol",
          cfl,
          buildUniswapConfig(_W("0.02"), _A("0.0005"), swapRouter.target),
          1n,
          guardian.address
        )
    ).to.be.revertedWith("Initializable: contract is already initialized");

    // outStable=0 is rejected
    await expect(StableSwapPayoutHandler.deploy(ZeroAddress)).to.be.revertedWith(
      "StableSwapPayoutHandler: outStable_ cannot be the zero address"
    );
  });

  it("Only allows GUARDIAN_ROLE to upgrade", async () => {
    const { payoutHandler, StableSwapPayoutHandler, usdt } = await helpers.loadFixture(deployContractsFixture);

    await expect(payoutHandler.connect(anon).upgradeTo(ZeroAddress)).to.be.revertedWith(
      accessControlMessage(anon, null, "GUARDIAN_ROLE")
    );

    const newImpl = await StableSwapPayoutHandler.deploy(usdt);
    await expect(payoutHandler.connect(guardian).upgradeTo(newImpl)).to.emit(payoutHandler, "Upgraded");
  });

  it("Can create policies and assigns it to the end user", async () => {
    const { rm, payoutHandler, pool } = await helpers.loadFixture(deployContractsFixture);
    const policyParams = await defaultBucketPolicyParams({ rm: rm, payout: _A(800), premium: _A(200) });
    policyParams.owner = cust;
    const signature = await makeSignedQuote(policyPricer, policyParams, makeBucketQuoteMessage);

    await expect(
      payoutHandler.connect(anon).newPolicyOnBehalfOf(...makeNewPolicyParams(policyParams, signature, rm))
    ).to.be.revertedWith(accessControlMessage(anon, null, "POLICY_CREATOR_ROLE"));

    const tx = await payoutHandler
      .connect(creator)
      .newPolicyOnBehalfOf(...makeNewPolicyParams(policyParams, signature, rm));

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

    const signatures = await Promise.all(
      policyParams.map((p) => makeSignedQuote(policyPricer, p, makeBucketQuoteMessage))
    );

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
    const policyParams = {
      ...(await defaultBucketPolicyParams({ rm: rm, payout: _A(354), premium: _A(80) })),
      owner: cust,
    };
    const signature = await makeSignedQuote(policyPricer, policyParams, makeBucketQuoteMessage);

    const creationTx = await payoutHandler
      .connect(creator)
      .newPolicyOnBehalfOf(...makeNewPolicyParams(policyParams, signature, rm));

    const newPolicyEvt = getTransactionEvent(pool.interface, await creationTx.wait(), "NewPolicy");

    const resolutionTx = await rm.connect(resolver).resolvePolicy([...newPolicyEvt.args.policy], _A(354));

    await expect(resolutionTx).to.changeTokenBalance(usdt, cust, _A(354));
  });

  it("Rejects unknown policies and their payouts", async () => {
    const { rm, payoutHandler, pool, cfl } = await helpers.loadFixture(deployContractsFixture);
    const policyParams = {
      ...(await defaultBucketPolicyParams({ rm: rm, payout: _A(354), premium: _A(80) })),
      owner: payoutHandler,
    };
    const signature = await makeSignedQuote(policyPricer, policyParams, makeBucketQuoteMessage);

    // We'll be creating/resolving some policies from an EOA
    await cfl.grantRole(await cfl.OWN_POLICY_CREATOR_ROLE(), creator);

    // Policy not created through the payout handler is rejected
    await expect(
      cfl.connect(creator).newPolicyOnBehalfOf(...makeNewPolicyParams(policyParams, signature, rm))
    ).to.be.revertedWith("StableSwapPayoutHandler: received unknown policy");

    // Transferred policies are rejected as well
    policyParams.owner = creator;
    const creationTx = await cfl
      .connect(creator)
      .newPolicyOnBehalfOf(...makeNewPolicyParams(policyParams, signature, rm));
    const newPolicyEvt = getTransactionEvent(pool.interface, await creationTx.wait(), "NewPolicy");

    await expect(
      pool.connect(creator).safeTransferFrom(creator, payoutHandler, newPolicyEvt.args[1].id)
    ).to.be.revertedWith("StableSwapPayoutHandler: received unknown policy");

    // Payouts are rejected
    await pool.connect(creator).transferFrom(creator, payoutHandler, newPolicyEvt.args[1].id);
    await expect(rm.connect(resolver).resolvePolicy([...newPolicyEvt.args.policy], _A(354))).to.be.revertedWith(
      "StableSwapPayoutHandler: received unknown policy"
    );

    await helpers.time.increaseTo(newPolicyEvt.args.policy.expiration + 500n);

    // Even though onPolicyExpired fails, the policy is still expired
    await expect(pool.expirePolicy([...newPolicyEvt.args.policy])).to.not.emit(payoutHandler, "Transfer");
    expect(await pool.isActive(newPolicyEvt.args[1].id)).to.be.false;
  });

  it("Burns NFT on policy expiration", async () => {
    const { rm, payoutHandler, pool } = await helpers.loadFixture(deployContractsFixture);
    const policyParams = {
      ...(await defaultBucketPolicyParams({ rm: rm, payout: _A(800), premium: _A(200) })),
      owner: cust,
    };
    const signature = await makeSignedQuote(policyPricer, policyParams, makeBucketQuoteMessage);

    const tx = await payoutHandler
      .connect(creator)
      .newPolicyOnBehalfOf(...makeNewPolicyParams(policyParams, signature, rm));

    const newPolicyEvt = getTransactionEvent(pool.interface, await tx.wait(), "NewPolicy");
    const policyId = newPolicyEvt.args[1].id;

    await helpers.time.increaseTo(newPolicyEvt.args.policy.expiration + 500n);
    await expect(pool.expirePolicy([...newPolicyEvt.args.policy]))
      .to.emit(payoutHandler, "Transfer")
      .withArgs(cust.address, ZeroAddress, policyId);

    expect(await payoutHandler.balanceOf(cust.address)).to.equal(0);
  });

  it("Allows end user to claim back the policy NFT", async () => {
    const { rm, payoutHandler, pool } = await helpers.loadFixture(deployContractsFixture);
    const policyParams = {
      ...(await defaultBucketPolicyParams({ rm: rm, payout: _A(800), premium: _A(200) })),
      owner: cust,
    };
    const signature = await makeSignedQuote(policyPricer, policyParams, makeBucketQuoteMessage);

    const tx = await payoutHandler
      .connect(creator)
      .newPolicyOnBehalfOf(...makeNewPolicyParams(policyParams, signature, rm));

    const newPolicyEvt = getTransactionEvent(pool.interface, await tx.wait(), "NewPolicy");

    expect(await pool.balanceOf(payoutHandler)).to.equal(1);
    await expect(payoutHandler.connect(anon).recoverPolicy(newPolicyEvt.args[1].id)).to.be.revertedWith(
      "StableSwapPayoutHandler: you must own the NFT to recover the policy"
    );

    await expect(payoutHandler.connect(cust).recoverPolicy(newPolicyEvt.args[1].id))
      .to.emit(pool, "Transfer")
      .withArgs(payoutHandler.target, cust.address, newPolicyEvt.args[1].id);

    expect(await pool.balanceOf(payoutHandler)).to.equal(0);
    expect(await pool.ownerOf(newPolicyEvt.args[1].id)).to.equal(cust);
  });

  it("Fails policy resolution if the swap slippage is too high", async () => {
    const { rm, payoutHandler, pool, currency, usdt, swapRouter } = await helpers.loadFixture(deployContractsFixture);

    // slippage is 50% off from the expected price
    await swapRouter.setCurrentPrice(currency, usdt, _W("1.5"));

    const policyParams = {
      ...(await defaultBucketPolicyParams({ rm: rm, payout: _A(354), premium: _A(80) })),
      owner: cust,
    };
    const signature = await makeSignedQuote(policyPricer, policyParams, makeBucketQuoteMessage);

    const creationTx = await payoutHandler
      .connect(creator)
      .newPolicyOnBehalfOf(...makeNewPolicyParams(policyParams, signature, rm));
    const newPolicyEvt = getTransactionEvent(pool.interface, await creationTx.wait(), "NewPolicy");

    await expect(rm.connect(resolver).resolvePolicy([...newPolicyEvt.args.policy], _A(354))).to.be.revertedWith(
      "The input amount exceeds the slippage"
    );
  });

  it("Uses the payoutHandler's own funds to cover minor slippage", async () => {
    const { rm, payoutHandler, pool, currency, usdt, swapRouter } = await helpers.loadFixture(deployContractsFixture);

    // provide some buffer funds to the payout handler
    await currency.connect(lp).transfer(payoutHandler, _A(100));

    // slippage is 1% off from the expected price
    await swapRouter.setCurrentPrice(currency, usdt, _W("1.01"));

    const policyParams = {
      ...(await defaultBucketPolicyParams({ rm: rm, payout: _A(354), premium: _A(80) })),
      owner: cust,
    };
    const signature = await makeSignedQuote(policyPricer, policyParams, makeBucketQuoteMessage);

    const creationTx = await payoutHandler
      .connect(creator)
      .newPolicyOnBehalfOf(...makeNewPolicyParams(policyParams, signature, rm));
    const newPolicyEvt = getTransactionEvent(pool.interface, await creationTx.wait(), "NewPolicy");

    const resolutionTx = await rm.connect(resolver).resolvePolicy([...newPolicyEvt.args.policy], _A(354));

    await expect(resolutionTx).to.changeTokenBalance(usdt, cust, _A(354));

    // The 1% slippage was covered by the funds in the payout handler
    await expect(resolutionTx).to.changeTokenBalance(currency, payoutHandler, -_A("3.54"));
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

function makeNewPolicyParams(policyParams, signature, rm) {
  return [
    rm.target,
    policyParams.payout,
    policyParams.premium,
    policyParams.lossProb,
    policyParams.expiration,
    getAddress(policyParams.owner),
    policyParams.bucketId,
    policyParams.policyData,
    signature.r,
    signature.yParityAndS,
    policyParams.validUntil,
  ];
}
