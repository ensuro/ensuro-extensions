# Ensuro Extensions

This package contains several extension / utility contracts to be used with the Ensuro Protocol.

Try running some of the following tasks:

```shell
npx hardhat help
npx hardhat test
GAS_REPORT=true npx hardhat test
```

## CashFlowLender

The objective of this contract is to support the operation of some partners that receive the money of the premiums several weeks after the policy was sold. This contract lends the money to pay the premiums while keeping the ownership of the policies as _collateral_. When there's a payout, it retains the funds up to cover the debt and releases the remaining to a previously configured address.

## QuadrataWhitelist

This is an implementation of [LPManualWhitelist](https://github.com/ensuro/ensuro/blob/main/contracts/LPManualWhitelist.sol) with an additional endpoint that verifies a Quadrata passport before whitelisting a new provider.

The supported roles are:

- `LP_WHITELIST_ROLE`: Can whitelist providers bypassing quadrata's check
- `QUADRATA_WHITELIST_ROLE`: Can whitelist providers that have a quadrata passport with the required attributes
- `LP_WHITELIST_ADMIN_ROLE`: Can change the contract settings and perform upgrades
- `DEFAULT_ADMIN_ROLE`: Can grant roles to addresses

Checkout [Quadrata's docs](https://docs.quadrata.com/integration/additional-information/constants#attributes) for the available attributes.

Checkout the method `_validateRequiredAttribute` for attributes with special validations.
