const { expect } = require("chai");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { WhitelistStatus } = require("@ensuro/core/js/deploy");

const { getRole, accessControlMessage } = require("@ensuro/core/js/test-utils");

const { fork } = require("./utils");

// hre.upgrades.silenceWarnings();

// Mumbai addresses
const POLICYPOOL_ADDRESS = "0x77066b63c710B4fA352018E0D8Af0e5cC7243181";
const QUADRATA_READER = "0x5C6b81212c0A654B6e247F8DEfeC9a95c63EF954";
const ADMIN_EOA = "0xD758aF6BFC2f0908D7C5f89942be52C36a6b3cab";

describe("Quadrata whitelist", () => {
  let owner, nobody, admin, operative, lp;

  beforeEach(async () => {
    [owner, nobody, admin, operative, lp] = await hre.ethers.getSigners();
  });

  fork.it("Can be initialized with a default status and a quadrata reader", 33179753, async () => {
    const { whitelist } = await deployWhitelist();

    const filter = whitelist.filters.QuadrataWhitelistModeChanged();
    const events = await whitelist.queryFilter(filter);
    expect(events.length).to.equal(1);
    expect(events[0].event).to.equal("QuadrataWhitelistModeChanged");
    expect(events[0].args.newMode.deposit).to.equal(WhitelistStatus.whitelisted);
    expect(events[0].args.newMode.withdraw).to.equal(WhitelistStatus.notdefined);
    expect(events[0].args.newMode.sendTransfer).to.equal(WhitelistStatus.notdefined);
    expect(events[0].args.newMode.receiveTransfer).to.equal(WhitelistStatus.notdefined);

    expect(await whitelist.reader()).to.equal(QUADRATA_READER);
  });

  fork.it("Allows only QUADRATA_WHITELIST_ROLE to whitelist", 33179753, async () => {
    const adminEOA = await hre.ethers.getImpersonatedSigner(ADMIN_EOA);

    const { whitelist, accessManager } = await deployWhitelist();

    await expect(whitelist.connect(nobody).quadrataWhitelist(lp.address)).to.be.revertedWith(
      accessControlMessage(nobody.address, whitelist.address, "QUADRATA_WHITELIST_ROLE")
    );

    await accessManager
      .connect(adminEOA)
      .grantComponentRole(whitelist.address, getRole("QUADRATA_WHITELIST_ROLE"), operative.address);

    await expect(whitelist.connect(operative).quadrataWhitelist(lp.address))
      .to.emit(whitelist, "LPWhitelistStatusChanged")
      .withArgs(lp.address, [
        WhitelistStatus.whitelisted,
        WhitelistStatus.notdefined,
        WhitelistStatus.notdefined,
        WhitelistStatus.notdefined,
      ]);
  });

  fork.it("Allows only admin to set the whitelist mode", 33179753, async () => {
    const adminEOA = await hre.ethers.getImpersonatedSigner(ADMIN_EOA);
    const { whitelist, accessManager } = await deployWhitelist();

    const newMode = Array(4).fill(WhitelistStatus.whitelisted);

    await expect(whitelist.connect(admin).setWhitelistMode(newMode)).to.be.revertedWith(
      accessControlMessage(admin.address, whitelist.address, "LP_WHITELIST_ADMIN_ROLE")
    );

    await accessManager
      .connect(adminEOA)
      .grantComponentRole(whitelist.address, getRole("LP_WHITELIST_ADMIN_ROLE"), admin.address);

    await expect(whitelist.connect(admin).setWhitelistMode(newMode))
      .to.emit(whitelist, "QuadrataWhitelistModeChanged")
      .withArgs(newMode);

    // the new mode must be used when whitelisting
    await accessManager
      .connect(adminEOA)
      .grantComponentRole(whitelist.address, getRole("QUADRATA_WHITELIST_ROLE"), operative.address);
    await expect(whitelist.connect(operative).quadrataWhitelist(lp.address))
      .to.emit(whitelist, "LPWhitelistStatusChanged")
      .withArgs(lp.address, newMode);
  });

  fork.it("Does not allow overriding whitelist defaults through quadrataWhitelist", 33179753, async () => {
    const adminEOA = await hre.ethers.getImpersonatedSigner(ADMIN_EOA);

    const { whitelist, accessManager } = await deployWhitelist();

    await accessManager
      .connect(adminEOA)
      .grantComponentRole(whitelist.address, getRole("QUADRATA_WHITELIST_ROLE"), operative.address);

    await expect(whitelist.connect(operative).quadrataWhitelist(hre.ethers.constants.AddressZero)).to.be.revertedWith(
      "Provider cannot be the zero address"
    );
  });
});

async function deployWhitelist(defaultStatus, whitelistMode, reader) {
  const QuadrataWhitelist = await hre.ethers.getContractFactory("QuadrataWhitelist");

  const whitelist = await hre.upgrades.deployProxy(
    QuadrataWhitelist,
    [
      defaultStatus || [
        WhitelistStatus.blacklisted, // deposit
        WhitelistStatus.whitelisted, // withdraw
        WhitelistStatus.whitelisted, // send
        WhitelistStatus.blacklisted, // receive
      ],
      whitelistMode || [
        WhitelistStatus.whitelisted, // deposit
        WhitelistStatus.notdefined, // withdraw
        WhitelistStatus.notdefined, // send
        WhitelistStatus.notdefined, // receive
      ],
      reader || QUADRATA_READER,
    ],
    {
      kind: "uups",
      unsafeAllow: [],
      constructorArgs: [POLICYPOOL_ADDRESS],
      initializer: "initializeQ", // TODO: this is ugly, find out how to properly handle the override
    }
  );

  const pool = await hre.ethers.getContractAt("PolicyPool", POLICYPOOL_ADDRESS);
  const accessManager = await hre.ethers.getContractAt("AccessManager", await pool.access());

  return { QuadrataWhitelist, whitelist, pool, accessManager };
}
