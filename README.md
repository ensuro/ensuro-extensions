# Ensuro Extensions

This package contains several extension / utility contracts to be used with the Ensuro Protocol.

Try running some of the following tasks:

```shell
npx hardhat help
npx hardhat test
GAS_REPORT=true npx hardhat test
```

## CashFlowLender

The objective of this contract is to support the operation of some partners that receive the money of the premiums several weeks after the policy was sold. This contract lends the money to pay the premiums while keeping the ownership of the policies as *collateral*. When there's a payout, it retains the funds up to cover the debt and releases the remaining to a previously configured address.
