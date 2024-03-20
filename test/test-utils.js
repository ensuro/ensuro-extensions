const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { _W, amountFunction } = require("@ensuro/core/js/utils");
const { ethers, MaxUint256 } = require("ethers");

const _A = amountFunction(6);

// eslint-disable-next-line func-style
const keccak256 = (str) => ethers.keccak256(ethers.toUtf8Bytes(str));

function getAddress(addressable) {
  return addressable.address || addressable.target || addressable;
}

async function defaultPolicyParams({ rm, payout, premium, lossProb, expiration, policyData, validUntil }) {
  const now = await helpers.time.latest();
  const rmAddress = rm ? await ethers.resolveAddress(rm) : rm;
  return {
    rmAddress,
    payout: payout || _A(1000),
    premium: premium || MaxUint256,
    lossProb: lossProb || _W(0.1),
    expiration: expiration || now + 3600 * 24 * 30,
    policyData: policyData || "0xb494869573b0a0ce9caac5394e1d0d255d146ec7e2d30d643a4e1d78980f3235",
    validUntil: validUntil || now + 3600 * 24 * 30,
  };
}

function newPolicy(rm, sender, policyParams, onBehalfOf, signature, method) {
  if (sender !== undefined) rm = rm.connect(sender);
  return rm[method || "newPolicy"](
    policyParams.payout,
    policyParams.premium,
    policyParams.lossProb,
    policyParams.expiration,
    onBehalfOf.address,
    policyParams.policyData,
    signature.r,
    signature.yParityAndS,
    policyParams.validUntil
  );
}

async function defaultBucketPolicyParams({
  rm,
  payout,
  premium,
  lossProb,
  expiration,
  policyData,
  bucketId,
  validUntil,
}) {
  const now = await helpers.time.latest();
  const rmAddress = rm ? await ethers.resolveAddress(rm) : rm;
  return {
    rmAddress,
    payout: payout || _A(1000),
    premium: premium || MaxUint256,
    lossProb: lossProb || _W(0.1),
    expiration: expiration || now + 3600 * 24 * 30,
    policyData: policyData || "0xb494869573b0a0ce9caac5394e1d0d255d146ec7e2d30d643a4e1d78980f3235",
    bucketId: bucketId || 0,
    validUntil: validUntil || now + 3600 * 24 * 30,
  };
}

function newBucketPolicy(cfl, rm, sender, policyParams, signature, method) {
  if (sender !== undefined) cfl = cfl.connect(sender);
  return cfl[method || "newPolicyWithRm"](
    getAddress(rm),
    policyParams.payout,
    policyParams.premium,
    policyParams.lossProb,
    policyParams.expiration,
    policyParams.policyData,
    policyParams.bucketId,
    signature.r,
    signature.yParityAndS,
    policyParams.validUntil
  );
}

function makeBatchParams(policyParams, signatures, rm) {
  const payout = policyParams.map((pp) => pp.payout);
  const premium = policyParams.map((pp) => pp.premium);
  const lossProb = policyParams.map((pp) => pp.lossProb);
  const expiration = policyParams.map((pp) => pp.expiration);
  const policyData = policyParams.map((pp) => pp.policyData);
  const quoteSignatureR = signatures.map((s) => s.r);
  const quoteSignatureVS = signatures.map((s) => s.yParityAndS);
  const validUntil = policyParams.map((pp) => pp.validUntil);
  if (rm) {
    const bucketId = policyParams.map((pp) => pp.bucketId);
    const riskModules = policyParams.map(() => getAddress(rm));
    return [
      riskModules,
      payout,
      premium,
      lossProb,
      expiration,
      policyData,
      bucketId,
      quoteSignatureR,
      quoteSignatureVS,
      validUntil,
    ];
  }
  return [payout, premium, lossProb, expiration, policyData, quoteSignatureR, quoteSignatureVS, validUntil];
}

module.exports = {
  newPolicy,
  defaultPolicyParams,
  makeBatchParams,
  defaultBucketPolicyParams,
  newBucketPolicy,
  keccak256,
  getAddress,
};
