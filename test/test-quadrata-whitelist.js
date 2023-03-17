const { expect } = require("chai");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { WhitelistStatus } = require("@ensuro/core/js/deploy");

const { getRole, accessControlMessage } = require("@ensuro/core/js/test-utils");

const { fork } = require("./utils");

// Mumbai addresses
const POLICYPOOL_ADDRESS = "0x77066b63c710B4fA352018E0D8Af0e5cC7243181";
const QUADRATA_READER = "0x5C6b81212c0A654B6e247F8DEfeC9a95c63EF954";
const ADMIN_EOA = "0xD758aF6BFC2f0908D7C5f89942be52C36a6b3cab";

const keccak256 = (str) => hre.ethers.utils.keccak256(hre.ethers.utils.toUtf8Bytes(str));

const attributes = {
  DID: keccak256("DID"),
  AML: keccak256("AML"),
  COUNTRY: keccak256("COUNTRY"),
  IS_BUSINESS: keccak256("IS_BUSINESS"),
  CRED_PROTOCOL_SCORE: keccak256("CRED_PROTOCOL_SCORE"),
};

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

  fork.it("Does not whitelist user with no passport or missing attributes", 33222066, async () => {
    const { whitelist } = await deployWhitelist({ whitelisters: [operative] });

    const userWithoutPassport = "0x4c56A8EFdd7aFd6A708641e3754801fE0538eb80";
    const reader = await hre.ethers.getContractAt("IQuadReader", QUADRATA_READER);
    const { assertAttributeValue } = await deployPassportInspector(reader.address);

    // User has no passport
    expect(await reader.balanceOf(userWithoutPassport, attributes.DID)).to.equal(0);
    expect(await reader.balanceOf(userWithoutPassport, attributes.AML)).to.equal(0);
    expect(await reader.balanceOf(userWithoutPassport, attributes.COUNTRY)).to.equal(0);

    // Can't be whitelisted
    await expect(whitelist.connect(operative).quadrataWhitelist(userWithoutPassport)).to.be.revertedWith(
      "User has no passport or is missing required attributes"
    );

    // TODO: mint a passport with only some attributes and improve this test with the different cases:
    //   - DID but no country
    //   - DID but no AML
  });

  fork.it("Whitelists user with fully compliant passport", 33222066, async () => {
    const { whitelist, whitelistMode } = await deployWhitelist({ whitelisters: [operative] });
    const { assertAttributeValue } = await deployPassportInspector(QUADRATA_READER);

    const userWithPassport = "0xbB90F2A3129abF4f1BE7Fa0528A929e2377dD705";

    // Baseline check: passport with DID, non-blacklisted country and highest AML score
    await assertAttributeValue(
      userWithPassport,
      attributes.DID,
      "0xd08185fb6845211640cf7c3f4355f8f886d7bcc7a3bd484b029b5a7539cdb55d"
    );
    await assertAttributeValue(userWithPassport, attributes.COUNTRY, keccak256("AR"));
    await assertAttributeValue(userWithPassport, attributes.AML, hre.ethers.utils.hexZeroPad("0x9", 32));

    // Can be whitelisted
    await expect(whitelist.connect(operative).quadrataWhitelist(userWithPassport))
      .to.emit(whitelist, "LPWhitelistStatusChanged")
      .withArgs(userWithPassport, whitelistMode);
  });
});

async function deployPassportInspector(readerAddress) {
  const PassportInspector = await hre.ethers.getContractFactory("PassportInspector");
  const inspector = await PassportInspector.deploy(readerAddress);

  async function assertAttributeValue(address, attribute, expected) {
    const tx = inspector.getAttributesBulk(address, [attribute]);
    await expect(tx).to.emit(inspector, "PassportAttributes").withArgs(attribute, expected);
  }

  return { inspector, assertAttributeValue };
}

async function deployWhitelist(options) {
  let { defaultStatus, whitelistMode, reader, whitelisters } = options || {};

  defaultStatus = defaultStatus || [
    WhitelistStatus.blacklisted, // deposit
    WhitelistStatus.whitelisted, // withdraw
    WhitelistStatus.whitelisted, // send
    WhitelistStatus.blacklisted, // receive
  ];

  whitelistMode = whitelistMode || [
    WhitelistStatus.whitelisted, // deposit
    WhitelistStatus.notdefined, // withdraw
    WhitelistStatus.notdefined, // send
    WhitelistStatus.notdefined, // receive
  ];

  const QuadrataWhitelist = await hre.ethers.getContractFactory("QuadrataWhitelist");

  const whitelist = await hre.upgrades.deployProxy(
    QuadrataWhitelist,
    [defaultStatus, whitelistMode, reader || QUADRATA_READER],
    {
      kind: "uups",
      unsafeAllow: [],
      constructorArgs: [POLICYPOOL_ADDRESS],
      initializer: "initializeQ", // TODO: this is ugly, find out how to properly handle the override
    }
  );

  const pool = await hre.ethers.getContractAt("PolicyPool", POLICYPOOL_ADDRESS);
  const accessManager = await hre.ethers.getContractAt("AccessManager", await pool.access());

  if (whitelisters !== undefined) {
    const adminEOA = await hre.ethers.getImpersonatedSigner(ADMIN_EOA);
    whitelisters.map(async (whitelister) => {
      await accessManager
        .connect(adminEOA)
        .grantComponentRole(whitelist.address, getRole("QUADRATA_WHITELIST_ROLE"), whitelister.address);
    });
  }

  return { QuadrataWhitelist, whitelist, pool, accessManager, defaultStatus, whitelistMode };
}
