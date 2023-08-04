const { expect } = require("chai");
const hre = require("hardhat");

const { WhitelistStatus } = require("@ensuro/core/js/enums");

const { getRole, accessControlMessage } = require("@ensuro/core/js/utils");

const { fork } = require("./utils");

const { ethers } = hre;

const { AddressZero, HashZero } = ethers.constants;

// Mumbai addresses
const mumbaiAddresses = {
  pool: "0x77066b63c710B4fA352018E0D8Af0e5cC7243181",
  quadrataReader: "0x5C6b81212c0A654B6e247F8DEfeC9a95c63EF954",
  admin: "0xD758aF6BFC2f0908D7C5f89942be52C36a6b3cab",
};

// Polygon addresses
const polygonAddresses = {
  pool: "0xD74A28274C4B1a116aDd9857FC0E8F5e8fAC2497",
  quadrataReader: "0xFEB98861425C6d2819c0d0Ee70E45AbcF71b43Da",
  quadrataGov: "0xBfa59A31b379A62304327386bC2b03096D7695B3",
  admin: "0xCfcd29CD20B6c64A4C0EB56e29E5ce3CD69336D2",
  quadAdmin: "0x76694A182dB047067521c73161Ebf3Db5Ca988d3",
};

// eslint-disable-next-line func-style
const keccak256 = (str) => ethers.utils.keccak256(ethers.utils.toUtf8Bytes(str));

const attributes = {
  DID: keccak256("DID"),
  AML: keccak256("AML"),
  COUNTRY: keccak256("COUNTRY"),
  IS_BUSINESS: keccak256("IS_BUSINESS"),
  CRED_PROTOCOL_SCORE: keccak256("CRED_PROTOCOL_SCORE"),
};

describe("Quadrata whitelist", () => {
  let admin, lp, nobody, operative, owner;

  beforeEach(async () => {
    [owner, nobody, admin, operative, lp] = await ethers.getSigners();
  });

  fork.it("Can be initialized with a default status and a quadrata reader", 33179753, async () => {
    const { whitelist, requiredAMLScore } = await deployWhitelist();

    let events = await whitelist.queryFilter(whitelist.filters.QuadrataWhitelistModeChanged());
    expect(events.length).to.equal(1);
    const whitelistModeEvent = events[0];
    expect(whitelistModeEvent.event).to.equal("QuadrataWhitelistModeChanged");
    expect(whitelistModeEvent.args.newMode.deposit).to.equal(WhitelistStatus.whitelisted);
    expect(whitelistModeEvent.args.newMode.withdraw).to.equal(WhitelistStatus.notdefined);
    expect(whitelistModeEvent.args.newMode.sendTransfer).to.equal(WhitelistStatus.notdefined);
    expect(whitelistModeEvent.args.newMode.receiveTransfer).to.equal(WhitelistStatus.notdefined);

    events = await whitelist.queryFilter(whitelist.filters.RequiredAMLScoreChanged());
    expect(events.length).to.equal(1);
    const requiredAMLScoreEvent = events[0];
    expect(requiredAMLScoreEvent.event).to.equal("RequiredAMLScoreChanged");
    expect(requiredAMLScoreEvent.args.requiredAMLScore).to.equal(requiredAMLScore);

    events = await whitelist.queryFilter(whitelist.filters.RequiredAttributeAdded());
    const requiredAttributes = events.map((evt) => evt.args.attribute);
    // by default we require all three attributes
    expect(requiredAttributes).to.have.members([attributes.DID, attributes.COUNTRY, attributes.AML]);
    expect(requiredAttributes.length).to.equal(3);

    expect(await whitelist.reader()).to.equal(mumbaiAddresses.quadrataReader);
  });

  fork.it("Allows only QUADRATA_WHITELIST_ROLE to whitelist", 33222066, async () => {
    const userWithPassport = "0xbB90F2A3129abF4f1BE7Fa0528A929e2377dD705";
    const adminEOA = await ethers.getImpersonatedSigner(mumbaiAddresses.admin);

    const { whitelist, accessManager, whitelistMode } = await deployWhitelist({ requiredAMLScore: 9 });

    await expect(whitelist.connect(nobody).quadrataWhitelist(lp.address)).to.be.revertedWith(
      accessControlMessage(nobody.address, whitelist.address, "QUADRATA_WHITELIST_ROLE")
    );

    await accessManager
      .connect(adminEOA)
      .grantComponentRole(whitelist.address, getRole("QUADRATA_WHITELIST_ROLE"), operative.address);

    await expect(whitelist.connect(operative).quadrataWhitelist(userWithPassport))
      .to.emit(whitelist, "LPWhitelistStatusChanged")
      .withArgs(userWithPassport, whitelistMode);
  });

  fork.it("Allows only admin to set the whitelist mode", 33222066, async () => {
    const userWithPassport = "0xbB90F2A3129abF4f1BE7Fa0528A929e2377dD705";
    const adminEOA = await ethers.getImpersonatedSigner(mumbaiAddresses.admin);
    const { whitelist, accessManager } = await deployWhitelist({
      whitelisters: [operative],
      requiredAMLScore: 9,
    });

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
    await expect(whitelist.connect(operative).quadrataWhitelist(userWithPassport))
      .to.emit(whitelist, "LPWhitelistStatusChanged")
      .withArgs(userWithPassport, newMode);
  });

  fork.it("Does not allow overriding whitelist defaults through quadrataWhitelist", 33179753, async () => {
    const { whitelist } = await deployWhitelist({ whitelisters: [operative] });

    await expect(whitelist.connect(operative).quadrataWhitelist(AddressZero)).to.be.revertedWith(
      "Provider cannot be the zero address"
    );
  });

  fork.it("Does not whitelist user with no passport or missing attributes", 33242153, async () => {
    const { whitelist } = await deployWhitelist({ whitelisters: [operative] });
    const { assertAttributeValue } = await deployPassportInspector(mumbaiAddresses.quadrataReader);

    const userWithoutPassport = "0x4c56A8EFdd7aFd6A708641e3754801fE0538eb80";
    const reader = await ethers.getContractAt("IQuadReader", mumbaiAddresses.quadrataReader);

    // User has no passport
    expect(await reader.balanceOf(userWithoutPassport, attributes.DID)).to.equal(0);
    expect(await reader.balanceOf(userWithoutPassport, attributes.AML)).to.equal(0);
    expect(await reader.balanceOf(userWithoutPassport, attributes.COUNTRY)).to.equal(0);

    // Can't be whitelisted
    await expect(whitelist.connect(operative).quadrataWhitelist(userWithoutPassport)).to.be.revertedWith(
      "User has no passport or is missing required attributes"
    );

    const userWithPassportMissingAML = "0x9CA0105B43Df30fa9f0BFbFD2611073A20519020";
    // Baseline check: user is missing AML
    await assertAttributeValue(
      userWithPassportMissingAML,
      attributes.DID,
      "0x0f8de4510f054c48d6eb2e720bd3e78dc3e119d4ea7023ecc9e7363562d9cbcd"
    );
    await assertAttributeValue(userWithPassportMissingAML, attributes.COUNTRY, keccak256("US"));
    await assertAttributeValue(userWithPassportMissingAML, attributes.AML, HashZero);

    // Can't be whitelisted
    await expect(whitelist.connect(operative).quadrataWhitelist(userWithoutPassport)).to.be.revertedWith(
      "User has no passport or is missing required attributes"
    );
  });

  fork.it("Whitelists user with fully compliant passport", 33222066, async () => {
    const { whitelist, whitelistMode } = await deployWhitelist({
      whitelisters: [operative],
      requiredAMLScore: 10,
    });
    const { assertAttributeValue } = await deployPassportInspector(mumbaiAddresses.quadrataReader);

    const userWithPassport = "0xbB90F2A3129abF4f1BE7Fa0528A929e2377dD705";

    // Baseline check: passport with DID, non-blacklisted country and highest AML score
    await assertAttributeValue(
      userWithPassport,
      attributes.DID,
      "0xd08185fb6845211640cf7c3f4355f8f886d7bcc7a3bd484b029b5a7539cdb55d"
    );
    await assertAttributeValue(userWithPassport, attributes.COUNTRY, keccak256("AR"));
    await assertAttributeValue(userWithPassport, attributes.AML, ethers.utils.hexZeroPad("0x9", 32));

    // Can be whitelisted
    await expect(whitelist.connect(operative).quadrataWhitelist(userWithPassport))
      .to.emit(whitelist, "LPWhitelistStatusChanged")
      .withArgs(userWithPassport, whitelistMode);
  });

  fork.it(
    "Whitelists user with fully compliant passport - POLYGON",
    40570967,
    async () => {
      const governance = await ethers.getContractAt("IQuadGovernance", polygonAddresses.quadrataGov);
      const quadAdmin = await ethers.getImpersonatedSigner(polygonAddresses.quadAdmin);
      // Send some gas to the admin
      owner.sendTransaction({
        to: quadAdmin.address,
        value: ethers.utils.parseEther("6.5"),
      });
      const { whitelist, whitelistMode } = await deployWhitelist({ whitelisters: [operative] }, polygonAddresses);
      // Preapprove the whitelist contract
      expect(await governance.preapproval(whitelist.address)).to.be.false;
      await governance.connect(quadAdmin).setPreapprovals([whitelist.address], [true]);
      expect(await governance.preapproval(whitelist.address)).to.be.true;

      const { inspector, assertAttributeValue } = await deployPassportInspector(polygonAddresses.quadrataReader);

      const userWithPassport = "0x4d68Cf31d613070b18E406AFd6A42719a62a0785";

      // Preapprove the inspector contract
      expect(await governance.preapproval(inspector.address)).to.be.false;
      await governance.connect(quadAdmin).setPreapprovals([inspector.address], [true]);
      expect(await governance.preapproval(inspector.address)).to.be.true;

      // Baseline check: passport with DID, non-blacklisted country and highest AML score
      await assertAttributeValue(
        userWithPassport,
        attributes.DID,
        "0x0b069a55c9228fb2bd84399faf316f97db44272c7ae4a20bd26d26f06b45ef58"
      );
      await assertAttributeValue(userWithPassport, attributes.COUNTRY, keccak256("AR"));
      await assertAttributeValue(userWithPassport, attributes.AML, ethers.utils.hexZeroPad("0x1", 32));

      // Can be whitelisted
      await expect(whitelist.connect(operative).quadrataWhitelist(userWithPassport))
        .to.emit(whitelist, "LPWhitelistStatusChanged")
        .withArgs(userWithPassport, whitelistMode);
    },
    "ALCHEMY_URL_POLYGON"
  );

  fork.it("Emits events with passport attributes on whitelist", 33222066, async () => {
    const { whitelist } = await deployWhitelist({
      whitelisters: [operative],
      requiredAMLScore: 9,
    });

    const userWithPassport = "0xbB90F2A3129abF4f1BE7Fa0528A929e2377dD705";

    const tx = whitelist.connect(operative).quadrataWhitelist(userWithPassport);
    await expect(tx)
      .to.emit(whitelist, "PassportAttribute")
      .withArgs(userWithPassport, attributes.DID, "0xd08185fb6845211640cf7c3f4355f8f886d7bcc7a3bd484b029b5a7539cdb55d");
    await expect(tx)
      .to.emit(whitelist, "PassportAttribute")
      .withArgs(userWithPassport, attributes.COUNTRY, keccak256("AR"));
    await expect(tx)
      .to.emit(whitelist, "PassportAttribute")
      .withArgs(userWithPassport, attributes.AML, ethers.utils.hexZeroPad("0x9", 32));
  });

  fork.it("Validates that user aml score is under threshold", 33235866, async () => {
    const { whitelist } = await deployWhitelist({ whitelisters: [operative], requiredAMLScore: 3 });
    const { assertAttributeValue } = await deployPassportInspector(mumbaiAddresses.quadrataReader);

    const userWithPassport = "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199";

    // Baseline check
    await assertAttributeValue(
      userWithPassport,
      attributes.DID,
      "0x2a145e0be8c129b136da03f2cea0eca8860309717d5b4ae372a49b34cfa9acef"
    );
    await assertAttributeValue(userWithPassport, attributes.COUNTRY, keccak256("US"));
    await assertAttributeValue(userWithPassport, attributes.AML, ethers.utils.hexZeroPad("0x4", 32));

    // Cannot be whitelisted
    await expect(whitelist.connect(operative).quadrataWhitelist(userWithPassport)).to.be.revertedWith(
      "AML score > required AML score"
    );
  });

  fork.it("Only allows admin to change required AML score", 33235866, async () => {
    const { whitelist, requiredAMLScore } = await deployWhitelist({ admins: [admin] });

    expect(await whitelist.requiredAMLScore()).to.equal(requiredAMLScore);

    await expect(whitelist.connect(nobody).setRequiredAMLScore(2)).to.be.revertedWith(
      accessControlMessage(nobody.address, whitelist.address, "LP_WHITELIST_ADMIN_ROLE")
    );

    await expect(whitelist.connect(admin).setRequiredAMLScore(2))
      .to.emit(whitelist, "RequiredAMLScoreChanged")
      .withArgs(2);

    expect(await whitelist.requiredAMLScore()).to.equal(2);
  });

  fork.it("Only allows admin to add/remove country from blacklist", 33235866, async () => {
    const { whitelist } = await deployWhitelist({ admins: [admin] });

    expect(await whitelist.countryBlacklisted(keccak256("CL"))).to.be.false;

    await expect(whitelist.connect(nobody).setCountryBlacklisted(keccak256("CL"), true)).to.be.revertedWith(
      accessControlMessage(nobody.address, whitelist.address, "LP_WHITELIST_ADMIN_ROLE")
    );

    await expect(whitelist.connect(admin).setCountryBlacklisted(keccak256("CL"), true))
      .to.emit(whitelist, "CountryBlacklistChanged")
      .withArgs(keccak256("CL"), true);
  });

  fork.it("Does not whitelist user from blacklisted country", 33235866, async () => {
    const { whitelist } = await deployWhitelist({ admins: [admin], whitelisters: [operative] });
    const { assertAttributeValue } = await deployPassportInspector(mumbaiAddresses.quadrataReader);
    const userWithPassport = "0xbB90F2A3129abF4f1BE7Fa0528A929e2377dD705";

    // Baseline check: passport with DID, non-blacklisted country and highest AML score
    await assertAttributeValue(
      userWithPassport,
      attributes.DID,
      "0xd08185fb6845211640cf7c3f4355f8f886d7bcc7a3bd484b029b5a7539cdb55d"
    );
    await assertAttributeValue(userWithPassport, attributes.COUNTRY, keccak256("AR"));
    await assertAttributeValue(userWithPassport, attributes.AML, ethers.utils.hexZeroPad("0x9", 32));

    // Blacklist user's country
    await whitelist.connect(admin).setCountryBlacklisted(keccak256("AR"), true);

    // User cannot be whitelisted
    await expect(whitelist.connect(operative).quadrataWhitelist(userWithPassport)).to.be.revertedWith(
      "Country not allowed"
    );
  });

  fork.it("Only allows admin to add required attributes", 33235866, async () => {
    const { whitelist, requiredAttributes } = await deployWhitelist({ admins: [admin] });

    expect(await whitelist.requiredAttributes()).to.eql(requiredAttributes);

    await expect(whitelist.connect(nobody).addRequiredAttribute(attributes.CRED_PROTOCOL_SCORE)).to.be.revertedWith(
      accessControlMessage(nobody.address, whitelist.address, "LP_WHITELIST_ADMIN_ROLE")
    );

    await expect(whitelist.connect(admin).addRequiredAttribute(attributes.CRED_PROTOCOL_SCORE))
      .to.emit(whitelist, "RequiredAttributeAdded")
      .withArgs(attributes.CRED_PROTOCOL_SCORE);
    expect(await whitelist.requiredAttributes()).to.eql([...requiredAttributes, attributes.CRED_PROTOCOL_SCORE]);

    // Adding is idempotent, so adding the same attribute again does not emit
    await expect(whitelist.connect(admin).addRequiredAttribute(attributes.CRED_PROTOCOL_SCORE)).not.to.emit(
      whitelist,
      "RequiredAttributeAdded"
    );
  });

  fork.it("Only allows admin to remove required attributes", 33235866, async () => {
    const { whitelist, requiredAttributes } = await deployWhitelist({
      admins: [admin],
      requiredAttributes: [attributes.DID, attributes.AML, attributes.COUNTRY],
    });

    expect(await whitelist.requiredAttributes()).to.eql(requiredAttributes);

    await expect(whitelist.connect(nobody).removeRequiredAttribute(attributes.AML)).to.be.revertedWith(
      accessControlMessage(nobody.address, whitelist.address, "LP_WHITELIST_ADMIN_ROLE")
    );

    await expect(whitelist.connect(admin).removeRequiredAttribute(attributes.AML))
      .to.emit(whitelist, "RequiredAttributeRemoved")
      .withArgs(attributes.AML);
    expect(await whitelist.requiredAttributes()).to.eql([attributes.DID, attributes.COUNTRY]);
  });
});

describe("Quadrata whitelist initializer", () => {
  it("Doesn't allow initialization on the implementation directly", async () => {
    const [, pool, reader] = await ethers.getSigners();
    const QuadrataWhitelist = await ethers.getContractFactory("QuadrataWhitelist");
    const wl = await QuadrataWhitelist.deploy(pool.address, reader.address);
    await expect(
      wl.initializeQuadrata(Array(4).fill(WhitelistStatus.whitelisted), Array(4).fill(WhitelistStatus.notdefined), 5, [
        attributes.DID,
      ])
    ).to.be.revertedWith("Initializable: contract is already initialized");
  });

  it("Doesn't allow initialization on the proxy", async () => {
    const [, pool, reader] = await ethers.getSigners();
    const QuadrataWhitelist = await ethers.getContractFactory("QuadrataWhitelist");
    const wl = await hre.upgrades.deployProxy(
      QuadrataWhitelist,
      [Array(4).fill(WhitelistStatus.whitelisted), Array(4).fill(WhitelistStatus.notdefined), 5, [attributes.DID]],
      {
        kind: "uups",
        unsafeAllow: [],
        constructorArgs: [pool.address, reader.address],
        initializer: "initializeQuadrata",
      }
    );
    await expect(
      wl.initializeQuadrata(Array(4).fill(WhitelistStatus.whitelisted), Array(4).fill(WhitelistStatus.notdefined), 5, [
        attributes.DID,
      ])
    ).to.be.revertedWith("Initializable: contract is already initialized");
  });

  it("Doesn't allow initialization calling initialize of the parent contract", async () => {
    const [, pool, reader] = await ethers.getSigners();
    const QuadrataWhitelist = await ethers.getContractFactory("QuadrataWhitelist");
    await expect(
      hre.upgrades.deployProxy(QuadrataWhitelist, [Array(4).fill(WhitelistStatus.whitelisted)], {
        kind: "uups",
        unsafeAllow: [],
        constructorArgs: [pool.address, reader.address],
        initializer: "initialize",
      })
    ).to.be.revertedWith("Parent initializer disabled");
  });
});

async function deployPassportInspector(readerAddress) {
  const PassportInspector = await ethers.getContractFactory("PassportInspector");
  const inspector = await PassportInspector.deploy(readerAddress);

  async function assertAttributeValue(address, attribute, expected) {
    const tx = inspector.getAttributesBulk(address, [attribute]);
    await expect(tx).to.emit(inspector, "PassportAttributes").withArgs(attribute, expected);
  }

  return { inspector, assertAttributeValue };
}

async function deployWhitelist(options, addresses = mumbaiAddresses) {
  let { defaultStatus, whitelistMode, reader, requiredAMLScore, requiredAttributes, whitelisters, admins } =
    options || {};

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

  requiredAMLScore = requiredAMLScore || 5;

  requiredAttributes = requiredAttributes || [attributes.DID, attributes.COUNTRY, attributes.AML];

  const QuadrataWhitelist = await ethers.getContractFactory("QuadrataWhitelist");
  const whitelist = await hre.upgrades.deployProxy(
    QuadrataWhitelist,
    [defaultStatus, whitelistMode, requiredAMLScore, requiredAttributes],
    {
      kind: "uups",
      unsafeAllow: [],
      constructorArgs: [addresses.pool, reader || addresses.quadrataReader],
      initializer: "initializeQuadrata",
    }
  );

  const pool = await ethers.getContractAt("PolicyPool", addresses.pool);
  const accessManager = await ethers.getContractAt("AccessManager", await pool.access());

  const adminEOA = await ethers.getImpersonatedSigner(addresses.admin);

  (whitelisters || []).map(async (whitelister) => {
    await accessManager
      .connect(adminEOA)
      .grantComponentRole(whitelist.address, getRole("QUADRATA_WHITELIST_ROLE"), whitelister.address);
  });

  (admins || []).map(async (admin) => {
    await accessManager
      .connect(adminEOA)
      .grantComponentRole(whitelist.address, getRole("LP_WHITELIST_ADMIN_ROLE"), admin.address);
  });

  return {
    QuadrataWhitelist,
    whitelist,
    pool,
    accessManager,
    defaultStatus,
    whitelistMode,
    requiredAMLScore,
    requiredAttributes,
  };
}
