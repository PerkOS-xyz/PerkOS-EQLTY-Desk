---
name: design-fee-split
description: Turn a plain fee-sharing intent for a token launch on Robinhood Chain into a Uniswap Liquidity Launchpad configuration, with the share of supply sold in the CCA auction, the FeeSplitter shares for the native and token sides, and the recipient contract each share lands in, explained in money with what each choice locks in permanently. Use when someone asks how a launch should split its supply or its trading fees, or needs the launchpad recipient contracts checked on chain. Analysis only, it never deploys, signs or submits anything.
---

# Design Fee Split

## Procedure

1. Check the launchpad contracts on Robinhood Chain first:

   ```bash
   node "{baseDir}/scripts/fee-split-advisor.mjs" verify
   ```

   Every contract must be `present` and all four FeeSplitters (v3.3.0 and
   v3.2.0) must report `matchesPublished: true`. Read `findings`: if one names
   a contract or route you were about to use, drop it and say why.

2. Restate the intent as two separate decisions: the share of total supply sold
   in the auction, and how trading fees are shared. If a percentage could mean
   either one, ask which. Do not guess.

3. Map each fee destination to one recipient:
   - `vault`: the creator's share, held in UERC20BeneficiaryVault.
   - `compounding`: fees that go back into the locked liquidity, through
     CompoundingClaimRecipient.
   - `buyback`: fees released only against a fixed token burn, through
     BuybackAndBurnClaimRecipient.
   - `vesting`: a creator share given up and released into buyback and burn
     at a capped rate, through VestingClaimRecipient. It never reaches the
     creator. It is paid to the v3.2.0 vault, the only published one the
     vesting contract allowlists. The caps are per block, per position. At the
     0.1009 s block time measured on 2026-09-26, release capacity builds up at
     about 107 ETH and 42.8 billion tokens (at 18 decimals) per position per
     day. That is a rate, not a daily ceiling: capacity not used while nobody
     claims carries over, so one claim after a pause can release more.
     Quote the current figures from `verify` under
     `recipients.vesting.releasePerDay`. When that is null, say the daily
     rate is unconfirmed.

   `vault` and `vesting` together use two different vaults and always need a
   new FeeSplitter.

4. Build the plan. Each share is a percentage of each fee side; write
   `native/token` when the two sides differ:

   ```bash
   node "{baseDir}/scripts/fee-split-advisor.mjs" plan \
     --auction-pct 55 --shares vault=40/0,compounding=60/100 --fees-usd 10000
   ```

   `feeSplitter.recipientRelease` names the launchpad release (v3.3.0 or
   v3.2.0) of every recipient in `splits`. It is null when the splits mix
   recipients from both releases. No published FeeSplitter does that, so a
   null release always needs a new FeeSplitter.

   Add `--total-supply <whole tokens>` to get `reservedTokenAmountForLP` and
   the buyback burn as a share of supply, and `--decimals <n>` when the token
   does not use 18. Add `--native-fee-pct <n>` only when the user states how
   fee value divides between the native and token sides.

5. If `blocked` is not empty, say that each entry does not work as designed
   with the contracts deployed today (an entry that says no claim could ever
   succeed cannot work at all), give each `reason`, and stop recommending it.

6. Explain the plan in money using `money.lines`, then give `locksIn`,
   `requires` and `unconfirmed` in plain words. Name every contract with its
   address. When `feeSplitter.deployed` or an entry of
   `feeSplitter.otherDeployedMatches` carries a `note`, explain it: it says
   whether that splitter's vault share can ever go to the vesting route. If
   `feeSplitter.needsNewDeployment` is true, say that a human has to deploy a
   new FeeSplitter and that this desk will not. For a `vault` or `vesting`
   share, always say that every position must be minted to the creator (each
   `overridePositionRecipient` left at `address(0)` or set to the creator),
   and that the creator can withdraw the liquidity until the FeeSplitter
   holds every position. For a plan with only `compounding` or `buyback`
   shares, say that every position must end up in the FeeSplitter, because
   it collects fees only for positions it holds: with `positionRecipient`
   set to the FeeSplitter, leave each `overridePositionRecipient` at
   `address(0)` or set it to the FeeSplitter.

Read [splitter-recipients.md](references/splitter-recipients.md) before
recommending a recipient.

## Guardrails

- Never sign, deploy or submit a transaction, and never move funds. This skill
  only reads the chain and computes a plan.
- Never invent an address, a share or a contract behavior. Use only what the
  script prints and what the reference file states.
- When supply, fee volume or the native and token mix is missing, say it is
  missing. Do not fill it in.
- Say before anyone acts that the auction share and the fee shares cannot be
  changed once a launch starts.
- Present fee figures as arithmetic on the volume the user assumed, never as a
  forecast.
- Do not recommend the vesting route unless `verify` reports
  `recipients.vesting.allowlistsVestingVault: true`.
- Do not recommend anything listed under `blocked`.
- Report everything under `unconfirmed` as unconfirmed.

## Verification

A plan is ready for the desk only when `verify` reports every contract
`present` and all four splitters matching their published splits, the plan's
`nativeBpsTotal` and `tokenBpsTotal` (summed from its splits) are both 10000,
`blocked` is empty, and no refusal was printed.
Always end by stating that nothing was deployed, signed or sent.
