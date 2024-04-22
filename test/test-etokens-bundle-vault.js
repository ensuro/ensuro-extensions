const {
  _W,
  amountFunction,
  getTransactionEvent,
  accessControlMessage,
  grantComponentRole,
  grantRole,
} = require("@ensuro/core/js/utils");
const {
  initCurrency,
  deployPool,
  deployPremiumsAccount,
  addRiskModule,
  addEToken,
} = require("@ensuro/core/js/test-utils");
const { ETokenParameter } = require("@ensuro/core/js/enums");
const hre = require("hardhat");
const { ethers } = hre;
const { MaxUint256 } = ethers;
const { expect } = require("chai");
const { WEEK } = require("@ensuro/core/js/constants");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { RiskModuleParameter, WhitelistStatus } = require("@ensuro/core/js/enums");

describe("ETokensBundleVault contract tests", function () {
  let _A;
  let admin, anon, cust, lp, lp2, lp3, resolver;
  let CENTS;
  let ONE;
  const NAME = "Bundle Vault";
  const SYMB = "etkBund";

  beforeEach(async () => {
    [, lp, lp2, lp3, cust, resolver, anon, admin] = await ethers.getSigners();

    _A = amountFunction(6);
    CENTS = _A("0.0001");
    ONE = _A("0.000001");
  });

  async function newPolicy(rm, srSCR, jrSCR, internalId, duration, onBehalfOf) {
    // CollRatio = 1
    // JrCollRatio = 0.4
    const payout = (srSCR * _A("1")) / _A("0.6");
    const jrSCRRatio = (jrSCR * _W("1")) / payout;
    expect(jrSCRRatio < _W("0.4")).to.be.true;
    const lossProb = _W("0.4") - jrSCRRatio;

    const now = await helpers.time.latest();
    return rm.newPolicy(
      payout,
      MaxUint256,
      lossProb,
      now + (duration || WEEK),
      (onBehalfOf || cust).address,
      internalId || 1
    );
  }

  async function deployPoolFixture() {
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(500000) },
      [lp, lp2, lp3, cust],
      [_A(100000), _A(200000), _A(30000), _A(5000)]
    );

    const pool = await deployPool({
      currency: currency,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
    });
    const poolAddr = await ethers.resolveAddress(pool);
    pool._A = _A;

    const accessManager = await ethers.getContractAt("AccessManager", await pool.access());

    // Infinite approvals from LPs to pool
    await currency.connect(lp).approve(pool, MaxUint256);
    await currency.connect(lp2).approve(pool, MaxUint256);
    await currency.connect(lp3).approve(pool, MaxUint256);
    // Customer approval
    await currency.connect(cust).approve(pool, MaxUint256);

    const jrETKs = [];
    const srETKs = [];
    const pas = [];
    const rms = [];

    const LPManualWhitelist = await ethers.getContractFactory("LPManualWhitelist");
    const TrustfulRiskModule = await ethers.getContractFactory("TrustfulRiskModule");

    const wl = await hre.upgrades.deployProxy(
      LPManualWhitelist,
      [
        [
          WhitelistStatus.blacklisted,
          WhitelistStatus.blacklisted,
          WhitelistStatus.whitelisted,
          WhitelistStatus.whitelisted,
        ],
      ],
      {
        constructorArgs: [poolAddr],
        kind: "uups",
      }
    );
    grantComponentRole(hre, accessManager, wl, "LP_WHITELIST_ROLE");
    grantComponentRole(hre, accessManager, wl, "LP_WHITELIST_ADMIN_ROLE");

    // Setup - 3 PAs, each one with Sr and Jr EToken and one Trustfull RM
    for (let i = 0; i < 3; i++) {
      const jr = await addEToken(pool, {});
      const sr = await addEToken(pool, {});
      if (i % 2 == 0) {
        await jr.setWhitelist(wl); // jr 0 and 2 will have WL
      } else {
        await sr.setWhitelist(wl); // sr 1 will have WL
      }
      const pa = await deployPremiumsAccount(pool, { srEtk: sr, jrEtk: jr });
      const rm = await addRiskModule(pool, pa, TrustfulRiskModule, {
        rmName: `RM ${i}`,
        collRatio: 1,
        maxPayoutPerPolicy: 10000,
      });
      await rm.setParam(RiskModuleParameter.jrCollRatio, _W("0.4"));
      await rm.setParam(RiskModuleParameter.jrRoc, _W("0.5"));
      await accessManager.grantComponentRole(rm, await rm.PRICER_ROLE(), cust);
      await accessManager.grantComponentRole(rm, await rm.RESOLVER_ROLE(), resolver);
      jrETKs.push(jr);
      srETKs.push(sr);
      pas.push(pa);
      rms.push(rm);
    }

    // Setup the liquidity sources
    const ETokensBundleVault = await ethers.getContractFactory("ETokensBundleVault");

    return { pool, currency, accessManager, jrETKs, srETKs, pas, rms, ETokensBundleVault, wl };
  }

  it("Initializes only with correct parameters", async () => {
    const { ETokensBundleVault, jrETKs, currency } = await helpers.loadFixture(deployPoolFixture);
    await expect(
      hre.upgrades.deployProxy(ETokensBundleVault, [NAME, SYMB, [], []], { kind: "uups" })
    ).to.be.revertedWith("ETokensBundleVault: the vault must have always at least one ETK");
    await expect(
      hre.upgrades.deployProxy(ETokensBundleVault, [NAME, SYMB, [await ethers.resolveAddress(jrETKs[0])], []], {
        kind: "uups",
      })
    ).to.be.revertedWith("ETokensBundleVault: etks and percentages lengths differ");
    await expect(
      hre.upgrades.deployProxy(
        ETokensBundleVault,
        [NAME, SYMB, [await ethers.resolveAddress(jrETKs[0])], [_W("0.4")]],
        { kind: "uups" }
      )
    ).to.be.revertedWith("ETokensBundleVault: total percentage must be 100%");
    const allJrs = jrETKs.map((etk) => etk);
    const allJrsAddrs = await Promise.all(allJrs.map(async (jr) => ethers.resolveAddress(jr)));
    await expect(
      hre.upgrades.deployProxy(ETokensBundleVault, [NAME, SYMB, allJrsAddrs, Array(3).fill(_W("0.4"))], {
        kind: "uups",
      })
    ).to.be.revertedWith("ETokensBundleVault: total percentage must be 100%");

    let vault = await hre.upgrades.deployProxy(
      ETokensBundleVault,
      [NAME, SYMB, allJrsAddrs, [_W("0.4"), _W("0.25"), _W("0.35")]],
      {
        kind: "uups",
      }
    );

    const receipt = await vault.deploymentTransaction().wait();
    let events = getTransactionEvents(vault.interface, receipt, "UnderlyingChanged");
    expect(events.length).to.be.equal(3);
    expect(events.map((evt) => evt.args.index)).to.deep.equal([0, 1, 2]);
    expect(events.map((evt) => evt.args.etk)).to.deep.equal(allJrsAddrs);

    expect(await vault.asset()).to.be.equal(currency);
    expect(await vault.name()).to.be.equal(NAME);
    expect(await vault.symbol()).to.be.equal(SYMB);
    expect(await vault.decimals()).to.be.equal(await currency.decimals());

    // Test it can't be initialized twice
    await expect(vault.initialize(NAME, SYMB, allJrsAddrs, [_W("0.4"), _W("0.25"), _W("0.35")])).to.be.revertedWith(
      "Initializable: contract is already initialized"
    );

    const underlying = await vault.getUnderlying();
    expect(underlying[0].length).to.be.equal(3);
    expect(underlying[1].length).to.be.equal(3);
    expect(underlying[0]).to.deep.equal(allJrsAddrs);
    expect(underlying[1]).to.deep.equal([_W("0.4"), _W("0.25"), _W("0.35")]);
  });

  it("Rejects mixing pools on initialization", async () => {
    const { ETokensBundleVault, jrETKs, currency, accessManager } = await helpers.loadFixture(deployPoolFixture);
    const anotherPool = await deployPool({
      currency: currency,
      access: accessManager,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
    });
    const alienETK = await addEToken(anotherPool, {});
    const etkAddrs = await Promise.all([jrETKs[0], alienETK].map(async (etk) => ethers.resolveAddress(etk)));
    await expect(
      hre.upgrades.deployProxy(ETokensBundleVault, [NAME, SYMB, etkAddrs, [_W("0.4"), _W("0.6")]], { kind: "uups" })
    ).to.be.revertedWith("ETokensBundleVault: Can't mix eTokens from different PolicyPool");
  });

  it("Checks implementation can't be initialized", async () => {
    const { ETokensBundleVault, jrETKs } = await helpers.loadFixture(deployPoolFixture);
    const impl = await ETokensBundleVault.deploy();
    const allJrs = jrETKs.map((etk) => etk);
    const allJrsAddrs = await Promise.all(allJrs.map(async (etk) => ethers.resolveAddress(etk)));
    await expect(impl.initialize(NAME, SYMB, allJrsAddrs, [_W("0.4"), _W("0.25"), _W("0.35")])).to.be.revertedWith(
      "Initializable: contract is already initialized"
    );
  });

  it("Checks only GUARDIAN_ROLE can upgrade", async () => {
    const { ETokensBundleVault, jrETKs } = await helpers.loadFixture(deployPoolFixture);
    const jrETKsAddrs = await Promise.all(jrETKs.map(async (etk) => ethers.resolveAddress(etk)));
    let vault = await hre.upgrades.deployProxy(
      ETokensBundleVault,
      [NAME, SYMB, jrETKsAddrs, [_W("0.4"), _W("0.25"), _W("0.35")]],
      {
        kind: "uups",
      }
    );
    await grantRole(hre, vault, "GUARDIAN_ROLE", admin);

    const newImpl = await ETokensBundleVault.deploy();

    await expect(vault.connect(anon).upgradeTo(newImpl)).to.be.revertedWith(
      accessControlMessage(anon, null, "GUARDIAN_ROLE")
    );

    const tx = await vault.connect(admin).upgradeTo(newImpl);
    const events = getTransactionEvents(vault.interface, await tx.wait(), "Upgraded");
    expect(events.length).to.be.equal(1);

    const underlying = await vault.getUnderlying();
    expect(underlying[0]).to.deep.equal(jrETKsAddrs);
    expect(underlying[1]).to.deep.equal([_W("0.4"), _W("0.25"), _W("0.35")]);
  });

  it("Checks addEToken validations", async () => {
    const { ETokensBundleVault, jrETKs, srETKs } = await helpers.loadFixture(deployPoolFixture);
    const etks = [jrETKs[1], srETKs[0], srETKs[2]]; // etks without WL
    const etksAddrs = await Promise.all(etks.map(async (etk) => ethers.resolveAddress(etk)));
    let vault = await hre.upgrades.deployProxy(
      ETokensBundleVault,
      [NAME, SYMB, etksAddrs, [_W("0.4"), _W("0.25"), _W("0.35")]],
      {
        kind: "uups",
      }
    );
    await grantRole(hre, vault, "ADMIN_ROLE", admin);

    await expect(vault.connect(anon).addEToken(jrETKs[0], Array(4).fill(_W("0.25")))).to.be.revertedWith(
      accessControlMessage(anon, null, "ADMIN_ROLE")
    );

    await expect(vault.connect(admin).addEToken(jrETKs[0], Array(3).fill(_W("0.25")))).to.be.revertedWith(
      "ETokensBundleVault: must send the new percentages"
    );

    await expect(vault.connect(admin).addEToken(jrETKs[1], Array(4).fill(_W("0.25")))).to.be.revertedWith(
      "ETokensBundleVault: eToken already in the bundle"
    );

    await expect(vault.connect(admin).addEToken(jrETKs[0], Array(4).fill(_W("0.24")))).to.be.revertedWith(
      "ETokensBundleVault: total percentage must be 100%"
    );

    const tx = await vault.connect(admin).addEToken(jrETKs[0], Array(4).fill(_W("0.25")));
    let events = getTransactionEvents(vault.interface, await tx.wait(), "UnderlyingChanged");
    expect(events.length).to.be.equal(4);
    expect(events.map((evt) => evt.args.index)).to.deep.equal([0, 1, 2, 3]);
    etksAddrs.push(await ethers.resolveAddress(jrETKs[0]));
    expect(events.map((evt) => evt.args.etk)).to.deep.equal(etksAddrs);
    expect(events.map((evt) => evt.args.percentage)).to.deep.equal(Array(4).fill(_W("0.25")));

    const underlying = await vault.getUnderlying();
    expect(underlying[0]).to.deep.equal(etksAddrs);
    expect(underlying[1]).to.deep.equal(Array(4).fill(_W("0.25")));
  });

  it("Checks it can't add eTokens from another pool", async () => {
    const { ETokensBundleVault, jrETKs, srETKs, accessManager, currency } =
      await helpers.loadFixture(deployPoolFixture);
    const etks = [jrETKs[1], srETKs[0], srETKs[2]]; // etks without WL
    const etksAddrs = await Promise.all(etks.map(async (etk) => ethers.resolveAddress(etk)));
    let vault = await hre.upgrades.deployProxy(
      ETokensBundleVault,
      [NAME, SYMB, etksAddrs, [_W("0.4"), _W("0.25"), _W("0.35")]],
      {
        kind: "uups",
      }
    );
    await grantRole(hre, vault, "ADMIN_ROLE", admin);

    const anotherPool = await deployPool({
      currency: currency,
      access: accessManager,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
    });
    const alienETK = await addEToken(anotherPool, {});

    await expect(vault.connect(admin).addEToken(alienETK, Array(4).fill(_W("0.25")))).to.be.revertedWith(
      "ETokensBundleVault: Can't mix eTokens from different PolicyPool"
    );
  });

  it("Checks removeEToken validations", async () => {
    const { ETokensBundleVault, jrETKs, srETKs } = await helpers.loadFixture(deployPoolFixture);
    const jrETKsAddrs = await Promise.all(jrETKs.map(async (etk) => ethers.resolveAddress(etk)));
    let vault = await hre.upgrades.deployProxy(
      ETokensBundleVault,
      [NAME, SYMB, jrETKsAddrs, [_W("0.4"), _W("0.25"), _W("0.35")]],
      {
        kind: "uups",
      }
    );
    await grantRole(hre, vault, "ADMIN_ROLE", admin);

    await expect(vault.connect(anon).removeEToken(jrETKs[0], Array(2).fill(_W("0.5")))).to.be.revertedWith(
      accessControlMessage(anon, null, "ADMIN_ROLE")
    );

    await expect(vault.connect(admin).removeEToken(jrETKs[0], Array(1).fill(_W("1")))).to.be.revertedWith(
      "ETokensBundleVault: must send the new percentages"
    );

    await expect(vault.connect(admin).removeEToken(srETKs[1], Array(2).fill(_W("0.5")))).to.be.revertedWith(
      "ETokensBundleVault: token to remove not found!"
    );

    await expect(vault.connect(admin).removeEToken(jrETKs[1], Array(2).fill(_W("0.4")))).to.be.revertedWith(
      "ETokensBundleVault: total percentage must be 100%"
    );

    // Remove one token in the middle
    let tx = await vault.connect(admin).removeEToken(jrETKs[1], Array(2).fill(_W("0.5")));
    let events = getTransactionEvents(vault.interface, await tx.wait(), "UnderlyingChanged");
    expect(events.length).to.be.equal(3);
    expect(events.map((evt) => evt.args.index)).to.deep.equal([0, 1, MaxUint256]);
    let currentEtks = [jrETKs[0], jrETKs[2], jrETKs[1]];
    let etksAddrs = await Promise.all(currentEtks.map(async (etk) => ethers.resolveAddress(etk)));
    expect(events.map((evt) => evt.args.etk)).to.deep.equal(etksAddrs);
    expect(events.map((evt) => evt.args.percentage)).to.deep.equal([_W("0.5"), _W("0.5"), MaxUint256]);

    let underlying = await vault.getUnderlying();
    currentEtks = [jrETKs[0], jrETKs[2]];
    etksAddrs = await Promise.all(currentEtks.map(async (etk) => ethers.resolveAddress(etk)));
    expect(underlying[0]).to.deep.equal(etksAddrs);
    expect(underlying[1]).to.deep.equal(Array(2).fill(_W("0.5")));

    // Remove the last token
    tx = await vault.connect(admin).removeEToken(jrETKs[2], [_W(1)]);
    events = getTransactionEvents(vault.interface, await tx.wait(), "UnderlyingChanged");
    expect(events.length).to.be.equal(2);
    expect(events.map((evt) => evt.args.index)).to.deep.equal([0, MaxUint256]);
    expect(events.map((evt) => evt.args.etk)).to.deep.equal(etksAddrs);
    expect(events.map((evt) => evt.args.percentage)).to.deep.equal([_W(1), MaxUint256]);

    underlying = await vault.getUnderlying();
    expect(underlying[0]).to.deep.equal([await ethers.resolveAddress(jrETKs[0])]);
    expect(underlying[1]).to.deep.equal([_W(1)]);

    // Can't remove the eToken is only one remains
    await expect(vault.connect(admin).removeEToken(jrETKs[0], [])).to.be.revertedWith(
      "ETokensBundleVault: must send the new percentages"
    );

    // Add one eToken and then I can remove the first one
    tx = await vault.connect(admin).addEToken(srETKs[1], [_W("0.75"), _W("0.25")]);
    tx = await vault.connect(admin).removeEToken(jrETKs[0], [_W(1)]);
    underlying = await vault.getUnderlying();
    expect(underlying[0]).to.deep.equal([await ethers.resolveAddress(srETKs[1])]);
    expect(underlying[1]).to.deep.equal([_W(1)]);
  });

  it("Checks change percentages validations", async () => {
    const { ETokensBundleVault, jrETKs } = await helpers.loadFixture(deployPoolFixture);
    const jrETKsAddrs = await Promise.all(jrETKs.map(async (etk) => ethers.resolveAddress(etk)));
    let vault = await hre.upgrades.deployProxy(
      ETokensBundleVault,
      [NAME, SYMB, jrETKsAddrs, [_W("0.4"), _W("0.25"), _W("0.35")]],
      {
        kind: "uups",
      }
    );
    await grantRole(hre, vault, "CHANGE_PERCENTAGE_ROLE", admin);

    await expect(vault.connect(anon).changePercentages([_W("0.35"), _W("0.25"), _W("0.4")])).to.be.revertedWith(
      accessControlMessage(anon, null, "CHANGE_PERCENTAGE_ROLE")
    );

    await expect(vault.connect(admin).changePercentages(Array(4).fill(_W("0.25")))).to.be.revertedWith(
      "ETokensBundleVault: must send the new percentages"
    );

    await expect(vault.connect(admin).changePercentages(Array(3).fill(_W("0.33")))).to.be.revertedWith(
      "ETokensBundleVault: total percentage must be 100%"
    );

    // Change percentages
    let tx = await vault.connect(admin).changePercentages([_W("0.35"), _W("0.25"), _W("0.4")]);
    let events = getTransactionEvents(vault.interface, await tx.wait(), "UnderlyingChanged");
    expect(events.length).to.be.equal(3);
    expect(events.map((evt) => evt.args.index)).to.deep.equal([0, 1, 2]);
    expect(events.map((evt) => evt.args.etk)).to.deep.equal(jrETKsAddrs);
    expect(events.map((evt) => evt.args.percentage)).to.deep.equal([_W("0.35"), _W("0.25"), _W("0.4")]);

    let underlying = await vault.getUnderlying();
    expect(underlying[0]).to.deep.equal(jrETKsAddrs);
    expect(underlying[1]).to.deep.equal([_W("0.35"), _W("0.25"), _W("0.4")]);
  });

  it("Checks reorderETokens validations", async () => {
    const { ETokensBundleVault, jrETKs } = await helpers.loadFixture(deployPoolFixture);
    const jrETKsAddrs = await Promise.all(jrETKs.map(async (etk) => ethers.resolveAddress(etk)));
    let vault = await hre.upgrades.deployProxy(
      ETokensBundleVault,
      [NAME, SYMB, jrETKsAddrs, [_W("0.4"), _W("0.25"), _W("0.35")]],
      {
        kind: "uups",
      }
    );
    await grantRole(hre, vault, "REORDER_ROLE", admin);

    await expect(vault.connect(anon).reorderETokens(0, 1)).to.be.revertedWith(
      accessControlMessage(anon, null, "REORDER_ROLE")
    );

    await expect(vault.connect(admin).reorderETokens(3, 0)).to.be.revertedWith(
      "ETokensBundleVault: values out of bounds"
    );

    await expect(vault.connect(admin).reorderETokens(0, 4)).to.be.revertedWith(
      "ETokensBundleVault: values out of bounds"
    );

    await expect(vault.connect(admin).reorderETokens(1, 1)).to.be.revertedWith(
      "ETokensBundleVault: values out of bounds"
    );

    // Switch 1st with last
    let tx = await vault.connect(admin).reorderETokens(0, 2);
    let events = getTransactionEvents(vault.interface, await tx.wait(), "UnderlyingChanged");
    expect(events.length).to.be.equal(2);
    expect(events.map((evt) => evt.args.index)).to.deep.equal([0, 2]);

    let currentEtks = [jrETKs[2], jrETKs[0]];
    let etksAddrs = await Promise.all(currentEtks.map(async (etk) => ethers.resolveAddress(etk)));
    expect(events.map((evt) => evt.args.etk)).to.deep.equal(etksAddrs); // [jrETKs[2], jrETKs[0]] addresses
    expect(events.map((evt) => evt.args.percentage)).to.deep.equal([_W("0.35"), _W("0.4")]);

    let underlying = await vault.getUnderlying();
    currentEtks = [jrETKs[2], jrETKs[1], jrETKs[0]];
    etksAddrs = await Promise.all(currentEtks.map(async (etk) => ethers.resolveAddress(etk)));
    expect(underlying[0]).to.deep.equal(etksAddrs); // [jrETKs[2], jrETKs[1], jrETKs[0]] addresses
    expect(underlying[1]).to.deep.equal([_W("0.35"), _W("0.25"), _W("0.4")]);
  });

  it("Checks deposits and withdrawals without restrictions", async () => {
    const { ETokensBundleVault, jrETKs, srETKs, currency, pool } = await helpers.loadFixture(deployPoolFixture);
    const etks = [jrETKs[1], srETKs[0], srETKs[2]]; // etks without WL
    const etksAddrs = await Promise.all(etks.map(async (etk) => ethers.resolveAddress(etk)));
    let vault = await hre.upgrades.deployProxy(
      ETokensBundleVault,
      [NAME, SYMB, etksAddrs, [_W("0.4"), _W("0.25"), _W("0.35")]],
      {
        kind: "uups",
      }
    );

    expect(await vault.maxDeposit(anon)).to.be.equal(MaxUint256);
    expect(await vault.maxMint(anon)).to.be.equal(MaxUint256);

    await expect(vault.connect(lp).deposit(_A(1000), lp)).to.be.revertedWith("ERC20: insufficient allowance");

    // LP1 deposits 1K
    await currency.connect(lp).approve(vault, MaxUint256);
    await expect(vault.connect(lp).deposit(_A(1000), lp))
      .to.emit(vault, "Deposit")
      .withArgs(lp, lp, _A(1000), _A(1000));

    // LP2 deposits 2K to anon
    await currency.connect(lp2).approve(vault, MaxUint256);
    await expect(vault.connect(lp2).deposit(_A(2000), anon))
      .to.emit(vault, "Deposit")
      .withArgs(lp2, anon, _A(2000), _A(2000));

    expect(await vault.totalAssets()).to.be.equal(_A(3000));
    expect(await vault.totalSupply()).to.be.equal(_A(3000));
    expect(await vault.balanceOf(lp)).to.be.equal(_A(1000));
    expect(await vault.balanceOf(lp2)).to.be.equal(_A(0));
    expect(await vault.balanceOf(anon)).to.be.equal(_A(2000));

    expect(await etks[0].balanceOf(vault)).to.be.equal(_A(1200)); // 3000 * .4
    expect(await etks[1].balanceOf(vault)).to.be.equal(_A(750)); // 3000 * .25
    expect(await etks[2].balanceOf(vault)).to.be.equal(_A(1050)); // 3000 * .35

    // LP3 deposits some funds to etks[0] directly and gifts them to the vault (easy way to simulate a return)
    await pool.connect(lp3).deposit(etks[0], _A(1500));
    await etks[0].connect(lp3).transfer(vault, _A(1500));
    expect(await vault.totalAssets()).to.be.equal(_A(4500));
    expect(await vault.totalSupply()).to.be.equal(_A(3000));

    expect(await vault.maxWithdraw(lp)).to.be.closeTo(_A(1500), CENTS); // 1/3 of the total assets
    expect(await vault.maxRedeem(lp)).to.be.closeTo(_A(1000), ONE);
    expect(await vault.maxWithdraw(anon)).to.be.closeTo(_A(3000), CENTS); // 2/3 of the total assets
    expect(await vault.maxRedeem(anon)).to.be.closeTo(_A(2000), ONE);

    // LP1 withdraws 1000
    let before = await currency.balanceOf(lp);
    await expect(vault.connect(lp).withdraw(_A(1000), lp, lp))
      .to.emit(vault, "Withdraw")
      .withArgs(lp, lp, lp, _A(1000), _A("666.666667"));
    expect(await currency.balanceOf(lp)).to.be.equal(before + _A(1000));

    // Check it was withdrawn proportional to assets
    expect(await etks[0].balanceOf(vault)).to.be.equal(_A(1200 + 1500 - 600)); // 60% of the assets
    expect(await etks[1].balanceOf(vault)).to.be.equal(_A(750) - _A("166.666667")); // 16.67%
    expect(await etks[2].balanceOf(vault)).to.be.equal(_A(1050) - _A("233.333333")); // 23.33%

    // LP1 redeems all its shares
    before = await currency.balanceOf(lp);
    await expect(vault.connect(lp).redeem((await vault.balanceOf(lp)) - ONE, lp, lp))
      .to.emit(vault, "Withdraw")
      .withArgs(lp, lp, lp, _A("499.999998"), _A("333.333332"));
    expect(await currency.balanceOf(lp)).to.be.closeTo(before + _A(500), CENTS);

    // anon redeems all its shares
    before = await currency.balanceOf(anon);
    await expect(vault.connect(anon).redeem(await vault.balanceOf(anon), anon, anon))
      .to.emit(vault, "Withdraw")
      .withArgs(anon, anon, anon, _A("3000"), _A("2000"));
    expect(await currency.balanceOf(anon)).to.be.closeTo(before + _A(3000), CENTS);
  });

  it("Checks deposits and withdrawals with manual rebalance", async () => {
    const { ETokensBundleVault, jrETKs, srETKs, currency } = await helpers.loadFixture(deployPoolFixture);
    const etks = [jrETKs[1], srETKs[0], srETKs[2]]; // etks without WL
    const etksAddrs = await Promise.all(etks.map(async (etk) => ethers.resolveAddress(etk)));
    let vault = await hre.upgrades.deployProxy(
      ETokensBundleVault,
      [NAME, SYMB, etksAddrs, [_W("0.4"), _W("0.6"), _W("0")]],
      {
        kind: "uups",
      }
    );

    // LP1 deposits 1K
    await currency.connect(lp).approve(vault, MaxUint256);
    await expect(vault.connect(lp).deposit(_A(1000), lp))
      .to.emit(vault, "Deposit")
      .withArgs(lp, lp, _A(1000), _A(1000));

    expect(await vault.totalAssets()).to.be.equal(_A(1000));
    expect(await vault.totalSupply()).to.be.equal(_A(1000));
    expect(await vault.balanceOf(lp)).to.be.equal(_A(1000));

    expect(await etks[0].balanceOf(vault)).to.be.equal(_A(400)); // 1000 * .4
    expect(await etks[1].balanceOf(vault)).to.be.equal(_A(600)); // 1000 * .6
    expect(await etks[2].balanceOf(vault)).to.be.equal(_A(0)); // 1000 * 0

    await grantRole(hre, vault, "REBALANCER_ROLE", admin);

    await expect(vault.connect(anon).rebalance(0, 1, _A(300))).to.be.revertedWith(
      accessControlMessage(anon, null, "REBALANCER_ROLE")
    );

    await expect(vault.connect(admin).rebalance(3, 0, _A(300))).to.be.revertedWith(
      "ETokensBundleVault: values out of bounds"
    );

    await expect(vault.connect(admin).rebalance(0, 3, _A(300))).to.be.revertedWith(
      "ETokensBundleVault: values out of bounds"
    );

    await expect(vault.connect(admin).rebalance(0, 2, _A(500))).to.be.revertedWith("amount > max withdrawable");

    await expect(vault.connect(admin).rebalance(0, 2, _A(0))).to.be.revertedWith(
      "EToken: amount to mint should be greater than zero"
    );

    await etks[1].setParam(ETokenParameter.minUtilizationRate, _W("0.1"));

    await expect(vault.connect(admin).rebalance(0, 1, _A(300))).to.be.revertedWith(
      "Deposit rejected - Utilization Rate < min"
    );

    let tx = await vault.connect(admin).rebalance(0, 2, _A(300));
    let events = getTransactionEvents(etks[0].interface, await tx.wait(), "Transfer");
    expect(events.length).to.be.equal(4);

    expect(await etks[0].balanceOf(vault)).to.be.equal(_A(100));
    expect(await etks[1].balanceOf(vault)).to.be.equal(_A(600));
    expect(await etks[2].balanceOf(vault)).to.be.equal(_A(300));
    expect(await vault.totalAssets()).to.be.equal(_A(1000));
    expect(await vault.totalSupply()).to.be.equal(_A(1000));

    tx = await vault.connect(admin).rebalance(0, 2, MaxUint256);
    events = getTransactionEvents(etks[0].interface, await tx.wait(), "Transfer");
    expect(events.length).to.be.equal(4);

    expect(await etks[0].balanceOf(vault)).to.be.equal(_A(0));
    expect(await etks[1].balanceOf(vault)).to.be.equal(_A(600));
    expect(await etks[2].balanceOf(vault)).to.be.equal(_A(400));
    expect(await vault.totalAssets()).to.be.equal(_A(1000));
    expect(await vault.totalSupply()).to.be.equal(_A(1000));
  });

  it("Checks deposits and withdrawals reject non-whitelisted users ", async () => {
    const { ETokensBundleVault, jrETKs, currency, wl } = await helpers.loadFixture(deployPoolFixture);
    const jrETKsAddrs = await Promise.all(jrETKs.map(async (etk) => ethers.resolveAddress(etk)));
    let vault = await hre.upgrades.deployProxy(
      ETokensBundleVault,
      [NAME, SYMB, jrETKsAddrs, [_W("0.4"), _W("0.25"), _W("0.35")]],
      {
        kind: "uups",
      }
    );
    await wl.whitelistAddress(vault, Array(4).fill(WhitelistStatus.whitelisted));

    expect(await vault.maxDeposit(anon)).to.be.equal(0);
    expect(await vault.maxMint(anon)).to.be.equal(0);

    await currency.connect(lp).approve(vault, MaxUint256);
    await expect(vault.connect(lp).deposit(_A(1000), lp)).to.be.revertedWith("ERC4626: deposit more than max");

    expect(await vault.maxDeposit(lp)).to.be.equal(0);
    expect(await vault.maxMint(lp)).to.be.equal(0);
    await wl.whitelistAddress(lp, [
      WhitelistStatus.whitelisted, // Only deposit whitelisted
      WhitelistStatus.blacklisted,
      WhitelistStatus.blacklisted,
      WhitelistStatus.blacklisted,
    ]);
    expect(await vault.maxDeposit(lp)).to.be.equal(MaxUint256);
    expect(await vault.maxMint(lp)).to.be.equal(MaxUint256);

    // LP1 deposits 1K
    await expect(vault.connect(lp).deposit(_A(1000), lp))
      .to.emit(vault, "Deposit")
      .withArgs(lp, lp, _A(1000), _A(1000));

    expect(await vault.totalAssets()).to.be.equal(_A(1000));
    expect(await vault.totalSupply()).to.be.equal(_A(1000));

    // Withdrawal is forbidden because LP blacklisted for withdraw
    expect(await vault.maxWithdraw(lp)).to.be.equal(0);
    expect(await vault.maxRedeem(lp)).to.be.equal(0);

    await wl.whitelistAddress(lp, Array(4).fill(WhitelistStatus.whitelisted));

    // Now withdrawal is enabled
    expect(await vault.maxWithdraw(lp)).to.be.equal(_A(1000));
    expect(await vault.maxRedeem(lp)).to.be.equal(_A(1000));

    // LP redeems all its shares, giving with anon as receiver
    let before = await currency.balanceOf(anon);
    await expect(vault.connect(lp).redeem(await vault.balanceOf(lp), anon, lp))
      .to.emit(vault, "Withdraw")
      .withArgs(lp, anon, lp, _A("1000"), _A("1000"));
    expect(await currency.balanceOf(anon)).to.be.closeTo(before + _A(1000), CENTS);
  });

  it("Checks deposits and withdrawals with minUR and withdrawable restrictions", async () => {
    const { ETokensBundleVault, jrETKs, srETKs, currency, pool, rms, wl } =
      await helpers.loadFixture(deployPoolFixture);

    // Whitelist everyone, for simplicity of the pair etks
    await wl.setWhitelistDefaults(Array(4).fill(WhitelistStatus.whitelisted));

    const etks = [jrETKs[1], srETKs[0], srETKs[2]]; // etks without WL
    const etksAddrs = await Promise.all(etks.map(async (etk) => ethers.resolveAddress(etk)));
    let vault = await hre.upgrades.deployProxy(
      ETokensBundleVault,
      [NAME, SYMB, etksAddrs, [_W("0.4"), _W("0.25"), _W("0.35")]],
      {
        kind: "uups",
      }
    );

    // LP3 deposits some funds to etks
    await pool.connect(lp3).deposit(etks[0], _A(100));
    await pool.connect(lp3).deposit(etks[1], _A(200));
    await pool.connect(lp3).deposit(etks[2], _A(300));
    await pool.connect(lp3).deposit(jrETKs[2], _A(1000));
    await pool.connect(lp3).deposit(srETKs[1], _A(1000));

    await etks[0].setParam(ETokenParameter.minUtilizationRate, _W("0.1"));

    // Anyone can deposit because the other etks still accept money
    expect(await vault.maxDeposit(anon)).to.be.equal(MaxUint256);
    expect(await vault.maxMint(anon)).to.be.equal(MaxUint256);

    // Lock some funds in etks[0] (jrETKs[1]) so UR is above 10% and accepts some deposits
    let tx = await newPolicy(rms[1].connect(cust), _A(100), _A(50));
    const policy0Evt = getTransactionEvent(pool.interface, await tx.wait(), "NewPolicy");

    expect(await etks[0].utilizationRate()).to.be.equal(_W("0.5"));

    // Anyone can deposit because the other etks still accept money
    expect(await vault.maxDeposit(anon)).to.be.equal(MaxUint256);
    expect(await vault.maxMint(anon)).to.be.equal(MaxUint256);

    await etks[1].setParam(ETokenParameter.minUtilizationRate, _W("0.1"));
    await etks[2].setParam(ETokenParameter.minUtilizationRate, _W("0.1"));

    // etk[0] ts = 100, scr = 50. To UR = 10%, ts can increase by 400.
    expect(await vault.maxDeposit(anon)).to.be.closeTo(_A(400), CENTS);
    expect(await vault.maxMint(anon)).to.be.closeTo(_A(400), CENTS);

    await rms[1].connect(resolver).resolvePolicy([...policy0Evt.args[1]], _A(0));

    expect(await vault.maxDeposit(anon)).to.be.equal(0);
    expect(await vault.maxMint(anon)).to.be.equal(0);

    await etks[1].setParam(ETokenParameter.minUtilizationRate, _W(0));

    // LP1 deposits 1K
    await currency.connect(lp).approve(vault, MaxUint256);
    await expect(vault.connect(lp).deposit(_A(1000), lp))
      .to.emit(vault, "Deposit")
      .withArgs(lp, lp, _A(1000), _A(1000));

    expect(await vault.totalAssets()).to.be.equal(_A(1000));
    expect(await vault.totalSupply()).to.be.equal(_A(1000));
    expect(await vault.balanceOf(lp)).to.be.equal(_A(1000));

    // All the deposit goes to etks[1] because the others don't accept deposits
    expect(await etks[0].balanceOf(vault)).to.be.equal(0);
    expect(await etks[1].balanceOf(vault)).to.be.equal(_A(1000));
    expect(await etks[2].balanceOf(vault)).to.be.equal(_A(0));

    // Check at this point, etks[1] can't be removed because the other etks don't accept the withdrawn funds
    await grantRole(hre, vault, "ADMIN_ROLE", admin);
    await expect(vault.connect(admin).removeEToken(etks[1], [_W("0.4"), _W("0.6")])).to.be.revertedWith(
      "ETokensBundleVault: couldn't allocate all the deposit"
    );

    // Lock some funds in etks[2], so UR is above 10% and accepts some deposits
    tx = await newPolicy(rms[2].connect(cust), _A(150), _A(75));
    const policy1Evt = getTransactionEvent(pool.interface, await tx.wait(), "NewPolicy");

    expect(await etks[2].utilizationRate()).to.be.equal(_W("0.5"));

    // LP2 deposits 2K
    await currency.connect(lp2).approve(vault, MaxUint256);
    await expect(vault.connect(lp2).deposit(_A(2000), lp2))
      .to.emit(vault, "Deposit")
      .withArgs(lp2, lp2, _A(2000), _A(2000));

    // All the deposit goes to etks[1] because the others don't accept deposits
    expect(await etks[0].balanceOf(vault)).to.be.equal(0);

    // etks[2] had 300, with SCR=150 + 1200 = 1500 => UR = 10%
    expect(await etks[2].balanceOf(vault)).to.be.closeTo(_A(1200), CENTS);
    expect(await etks[2].utilizationRate()).to.be.equal(_W("0.1")); // UR in the minLevel

    // The remaining funds go to etks[1]
    expect(await etks[1].balanceOf(vault)).to.be.closeTo(_A(1800), CENTS);

    // LP3 withdraws everything in etks[2]
    await pool.connect(lp3).withdraw(etks[2], MaxUint256);
    expect(await etks[2].totalSupply()).to.be.closeTo(_A(1200), CENTS);

    // Check at this point, etks[2] can't be removed because not all the funds are withdrawable
    await expect(vault.connect(admin).removeEToken(etks[2], [_W("0.4"), _W("0.6")])).to.be.revertedWith(
      "amount > max withdrawable"
    );

    // Lock more the funds in etks[2]
    tx = await newPolicy(rms[2].connect(cust), _A(950), _A(75), 2);
    const policy2Evt = getTransactionEvent(pool.interface, await tx.wait(), "NewPolicy");

    expect(await vault.maxWithdraw(lp2)).to.be.closeTo(_A(1900), CENTS);
    expect(await vault.maxRedeem(lp2)).to.be.closeTo(_A(1900), ONE);

    await expect(vault.connect(lp2).withdraw(_A(1000), lp2, lp2))
      .to.emit(vault, "Withdraw")
      .withArgs(lp2, lp2, lp2, _A(1000), _A(1000) - ONE);

    expect(await etks[2].utilizationRate()).to.be.equal(_W("1"));
    expect(await etks[2].balanceOf(vault)).to.be.closeTo(_A(1100), CENTS);
    expect(await etks[1].balanceOf(vault)).to.be.closeTo(_A(900), CENTS);

    // LP1 can withdraw only 900
    expect(await vault.maxWithdraw(lp)).to.be.closeTo(_A(900), CENTS);

    const lp1MaxRedeem = await vault.maxRedeem(lp);
    expect(lp1MaxRedeem).to.be.closeTo(_A(900), CENTS);

    await expect(vault.connect(lp).redeem(lp1MaxRedeem, lp, lp)).to.emit(vault, "Withdraw");

    expect(await etks[1].balanceOf(vault)).to.be.closeTo(_A(0), CENTS);
    expect(await etks[2].balanceOf(vault)).to.be.closeTo(_A(1100), CENTS);

    expect(await vault.maxWithdraw(lp2)).to.be.closeTo(_A(0), CENTS);

    await rms[2].connect(resolver).resolvePolicy([...policy1Evt.args[1]], _A(0));
    await rms[2].connect(resolver).resolvePolicy([...policy2Evt.args[1]], _A(0));
    expect(await etks[2].utilizationRate()).to.be.equal(_W(0));

    // Now etks[2] can be removed and funds will be deposited into etks[1] (since etks[0] doesn't accept
    // deposit)
    await expect(vault.connect(admin).removeEToken(etks[2], [_W("0.4"), _W("0.6")])).to.emit(etks[2], "Transfer");

    const etk2Balance = _A(1100) + policy1Evt.args[1].srCoc + policy2Evt.args[1].srCoc;
    expect(await etks[2].balanceOf(vault)).to.be.closeTo(_A(0), CENTS);
    expect(await etks[1].balanceOf(vault)).to.be.closeTo(etk2Balance, CENTS);

    await expect(vault.connect(lp).redeem((await vault.balanceOf(lp)) - ONE, lp, lp)).to.emit(vault, "Withdraw");
    await expect(vault.connect(lp2).redeem((await vault.balanceOf(lp2)) - ONE, lp2, lp2)).to.emit(vault, "Withdraw");
  });

  it("Checks inflation attack is unprofitable", async () => {
    const { ETokensBundleVault, jrETKs, currency, pool } = await helpers.loadFixture(deployPoolFixture);
    const etks = [jrETKs[1]]; // etks without WL
    const etkAddrs = await Promise.all(etks.map(async (etk) => ethers.resolveAddress(etk)));
    let vault = await hre.upgrades.deployProxy(ETokensBundleVault, [NAME, SYMB, etkAddrs, [_W("1")]], {
      kind: "uups",
    });

    const victimDeposit = _A(500);

    // LP1 is the attacker
    // LP2 is the victim
    // LP2 want's to do a the first deposit of `victimDeposit` and LP1 front runs her.

    // LP1 deposits ONE
    await currency.connect(lp).approve(vault, MaxUint256);
    await expect(vault.connect(lp).deposit(ONE, lp)).to.emit(vault, "Deposit").withArgs(lp, lp, ONE, ONE);

    // LP1 deposits some funds to etks[0] directly and gifts them to the vault
    await pool.connect(lp).deposit(etks[0], victimDeposit * 2n);
    await etks[0].connect(lp).transfer(vault, victimDeposit * 2n);
    expect(await vault.totalAssets()).to.be.equal(victimDeposit * 2n + ONE);
    expect(await vault.totalSupply()).to.be.equal(ONE);

    const attackerCost = victimDeposit * 2n + ONE;

    // LP2 deposits 500 and gets 0 shares
    await currency.connect(lp2).approve(vault, MaxUint256);
    await expect(vault.connect(lp2).deposit(victimDeposit, lp2))
      .to.emit(vault, "Deposit")
      .withArgs(lp2, lp2, victimDeposit, _A(0));

    expect(await vault.totalSupply()).to.be.equal(ONE);
    expect(await vault.totalAssets()).to.be.equal(victimDeposit * 3n + ONE);
    const attackerProfit = (victimDeposit * 3n) / 2n + ONE;
    expect(await vault.maxWithdraw(lp)).to.be.equal(attackerProfit);

    await expect(vault.connect(lp).redeem(ONE, lp, lp))
      .to.emit(vault, "Withdraw")
      .withArgs(lp, lp, lp, attackerProfit, ONE);

    expect(await vault.totalSupply()).to.be.equal(0);
    expect(await vault.totalAssets()).to.be.equal(attackerProfit - ONE);
    // Attacker profit is less than attacker's cost
    expect(attackerProfit < attackerCost).to.be.true;
  });

  it("Checks deposits and withdrawals without restrictions", async () => {
    const { ETokensBundleVault, jrETKs, srETKs } = await helpers.loadFixture(deployPoolFixture);
    const etks = [jrETKs[1], srETKs[0], srETKs[2]]; // etks without WL
    const etkAddrs = await Promise.all(etks.map(async (etk) => ethers.resolveAddress(etk)));
    let vault = await hre.upgrades.deployProxy(
      ETokensBundleVault,
      [NAME, SYMB, etkAddrs, [_W("0.4"), _W("0.25"), _W("0.35")]],
      {
        kind: "uups",
      }
    );

    expect(await vault.maxDeposit(anon)).to.be.equal(MaxUint256);
    expect(await vault.maxMint(anon)).to.be.equal(MaxUint256);
  });
});

/**
 * Finds events with a given name in the receipt
 * @param {Interface} interface The interface of the contract that contains the requested event
 * @param {TransactionReceipt} receipt Transaction receipt containing the events in the logs
 * @param {String} eventName The name of the event we are interested in
 * @returns array of {LogDescription}
 */
function getTransactionEvents(interface, receipt, eventName) {
  return receipt.logs
    .map((log) => {
      let parsedLog;
      try {
        parsedLog = interface.parseLog(log);
        if (parsedLog?.name == eventName) return parsedLog;
      } catch (error) {
        /* empty */
      }
      return null;
    })
    .filter((x) => x !== null);
}
