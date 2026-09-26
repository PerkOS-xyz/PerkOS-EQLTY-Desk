# Splitter recipients on Robinhood Chain

What the Treasury specialist relies on when it turns a fee-sharing intent into
a Liquidity Launchpad configuration. Every statement below comes from the
Uniswap `liquidity-launcher` or `continuous-clearing-auction` source at the
commit the deployments page gives for the deployed contract, the Uniswap
developer docs, or a read of Robinhood Chain that `fee-split-advisor.mjs
verify` repeats. Citations are `file:line` at the named commit. Anything that
could not be confirmed is listed as unconfirmed.

## Contracts on Robinhood Chain (chainId 4663)

| Contract | Address | Version | Source commit |
| --- | --- | --- | --- |
| ContinuousClearingAuctionFactory | `0x000000001F26a0044BaA66024e7b6599c61963F8` | v2.1.0 | `7d7602d` (continuous-clearing-auction) |
| LiquidityLauncher | `0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0` | v3.2.0 | `dd8769c` |
| LBPStrategy | `0xbf1aB81f7d534b2CC0Da76fcf4d541322bB0e000` | v3.3.0 | `1c59049` |
| TokenSplitter | `0x4F5E3FBb9745358A92Da5674305FAb8D2B8a73cE` | v3.2.0 | `dd8769c` |
| FeeSplitter (creator fee) | `0x9411fa7F956f64aa7981AA27cB3bC6eC0415449C` | v3.3.0 | `7ea523c` |
| FeeSplitter (no creator fee) | `0x882Ae5e2095435A62Fd1BBDEfcb637f5CeAFc0ee` | v3.3.0 | `7ea523c` |
| FeeSplitter (creator fee) | `0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf` | v3.2.0 | `dd8769c` |
| FeeSplitter (no creator fee) | `0x222D6d4f1ce59b0d48D5505114eC8Addc90A4359` | v3.2.0 | `dd8769c` |
| UERC20BeneficiaryVault | `0x26d2F7AcB07707034406a0dC458351Bb63C02553` | v3.3.0 | `7ea523c` |
| UERC20BeneficiaryVault | `0xd35E9CA72F64C7F93BE30fad67524323396B36D7` | v3.2.0 | `dd8769c` |
| CompoundingClaimRecipient | `0xf585b5D728A8fdE743027307BF5F3556E3B9C58D` | v3.3.0 | `7ea523c` |
| CompoundingClaimRecipient | `0xf9526Dd3361fe0ba6b7a99533ed471D3E808E99a` | v3.2.0 | `dd8769c` |
| BuybackAndBurnClaimRecipient | `0xa1ba4CC12654D2b188e3ba77dc86c75cA47f1A4e` | v3.2.0 | `0b5ee05` |
| VestingClaimRecipient | `0xeF451B293ED8C61d20f7d13ef336a496F0cc2c26` | not published | `0b5ee05` |
| UniversalRouterStrategy | `0x0A122717bc36E3C7A7958128a5C789E0b070b3Ae` | v3.3.0 | `1c59049` |
| InitializerHook | `0x5fB5229FBA341dFE5a7e6A14d4809D6Cf887a000` | v3.3.0 | `7ea523c` |

Addresses, versions and commits are the ones on the official deployments page.
All sixteen had bytecode at block 72,800,602 (2026-09-26). The FeeSplitters,
vaults, compounding recipients, buyback recipient and vesting contract all
report the v4 PositionManager `0x58daec3116aae6D93017bAAea7749052E8a04fA7`,
the one the launcher's deploy parameters name for Robinhood Chain.

`FeeSplitter.sol`, `UERC20BeneficiaryVault.sol`, `BeneficiaryVault.sol` and
`CompoundingClaimRecipient.sol` are byte-identical at `7ea523c` and `dd8769c`,
so the v3.2.0 and v3.3.0 copies behave the same. `VestingClaimRecipient.sol`
and `BuybackAndBurnClaimRecipient.sol` are identical at `0b5ee05` and
`7ea523c`. `BaseClaimRecipient.sol` differs between the releases only in when
`claim` checks its minimum amounts.

## Units

- Supply shares use mps: 10,000,000 mps is 100%, so 1% is 100,000 mps.
- Fee shares use basis points per side: 10,000 bps is 100% of that side.

## Supply split between the auction and the pool

- The docs page on strategies documents `MigratorParameters.tokenSplitToAuction`,
  a `uint24` in mps giving the share of total supply sent to the auction. That
  field belongs to the original LBP strategy (v1.0.0 candidate source; v2.0.0
  renamed it `tokenSplit`). The script reports the share as `auctionShareMps`
  so nobody passes the legacy name to the deployed contract.
- The deployed LBPStrategy v3.3.0 takes `reservedTokenAmountForLP`, an
  absolute amount kept for the pool, and sends
  `totalSupply - reservedTokenAmountForLP` to the auction
  (`LBPStrategy.sol:85-89` at `1c59049`). It rejects a reserve of zero or above
  the `int128` maximum (`MigratorParams.sol:125`) and a reserve equal to or
  above the total supply (`LBPStrategy.sol:86`). So the auction share must be
  above 0% and below 100%.
- The auction accepts at most 2^100 base units
  (`ConstantsLib.sol:16` and `AuctionStorage.sol:72` at `7d7602d`). The script
  refuses a plan above it. Because the auction always gets at least 1e-7 of the
  supply, that cap also keeps the reserve under the `int128` limit.
- The script converts the share: `auctionSupply = floor(totalSupply * mps / 1e7)`
  and `reservedTokenAmountForLP = totalSupply - auctionSupply`.
- The strategy stores these parameters in `initializeDistribution` and has no
  function that changes them afterwards.
- How much raised currency goes into the pool is a separate decision,
  `lpAllocationSchedule`. This skill does not design it.
- The pool pairs the raised currency with the token, sorted by address
  (`LBPStrategy.sol:465-472`). Native ETH is always `currency0`.

## FeeSplitter rules

A split is `FeeSplit { recipient, nativeBps, tokenBps, useCallback }`. The
constructor rejects (`FeeSplitter.sol:208-231`):

- an empty list of splits;
- a recipient that is the zero address or the splitter itself;
- a split with zero on both sides;
- a callback recipient with no bytecode;
- the same recipient twice;
- a side whose shares do not total exactly 10,000.

Once deployed:

- It holds every position it receives. It has no function that transfers a
  position out (`FeeSplitter.sol:24`); the only actions are the permissionless
  `collectFees` and `increaseLiquidity`, and the second reverts while fees are
  uncollected (`FeeSplitter.sol:90`).
- It collects fees only for positions it holds: `collectFees` reverts with
  `NotOwner` for any other (`FeeSplitter.sol:66-68`). A position that never
  reaches it is outside the split. For a plan with only compounding or
  buyback shares that names the FeeSplitter as the CCA launch's
  `positionRecipient` (see Unconfirmed), every `overridePositionRecipient`
  must be `address(0)` or the FeeSplitter, because a nonzero override
  replaces `positionRecipient` for that position (`PositionPlanner.sol:148-155`
  at `1c59049`).
- The splits never change and can be read with `getSplits()`. The caller of
  `collectFees` cannot redirect them.
- It does not refuse a position whose `currency0` is an ERC-20.
  `onERC721Received` checks only that the caller is the PositionManager
  (`FeeSplitter.sol:118-121`), and the LBPStrategy mints positions straight to
  their recipient (`PositionPlanner.sol:244-252` at `1c59049`). The currency is
  checked only in `increaseLiquidity` and in `collectFees`, both of which
  revert with `InvalidBaseCurrency` unless `currency0` is native ETH
  (`FeeSplitter.sol:89` and `:154`). So a position paired with an ERC-20 would
  be locked in the splitter forever with its fees uncollectable. A launch that
  uses a FeeSplitter must pair native ETH with the token, and for a CCA launch
  that means raising native ETH.
- `currency1` must be a standard, unrestricted token (periphery `README.md:11`
  at both commits).
- Positions whose hook needs `hookData` are not supported (`FeeSplitter.sol:25`).
- Native shares are force-sent, so a recipient cannot block collection by
  refusing ETH (`FeeSplitter.sol:196-199`). A recipient whose notification
  reverts makes that collection revert, and those fees stay in the pool.
- Different splits mean a different FeeSplitter. The deployments page says
  several can exist on one chain. Deploying one is outside this desk.

`useCallback` is true for every launchpad recipient. Attribution through
`onAmountsReceived` is public (`BaseClaimRecipient.sol:41`), so without the
splitter's notification any caller could attribute the unassigned balance to a
position of its choice. All four deployed splitters use `true`.

## Deployed FeeSplitters

| FeeSplitter | Version | Splits (native / token) | Used by |
| --- | --- | --- | --- |
| `0x9411fa7F956f64aa7981AA27cB3bC6eC0415449C` | v3.3.0 | vault v3.3.0 40% / 0%; compounding v3.3.0 60% / 100% | InstantLaunchStrategy v3.3.0 with creator fees, `0x7c48DDe3B447381F4d986334679b3Afc7F2D35C2` |
| `0x882Ae5e2095435A62Fd1BBDEfcb637f5CeAFc0ee` | v3.3.0 | compounding v3.3.0 100% / 100% | InstantLaunchStrategy v3.3.0 without creator fees, `0xC9566675b1Ea42861546f3c5B74Ace2c79c49572` |
| `0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf` | v3.2.0 | vault v3.2.0 40% / 0%; compounding v3.2.0 60% / 100% | InstantLaunchStrategy v3.2.0 with creator fees, `0x23f8209572b4a1C2AD88A42749E830791Fb027f1` |
| `0x222D6d4f1ce59b0d48D5505114eC8Addc90A4359` | v3.2.0 | compounding v3.2.0 100% / 100% | InstantLaunchStrategy v3.2.0 without creator fees, `0xAD44D55E7f8337C3cE113fBb591486E85be104b2` |

`getSplits()` on all four returned exactly these splits, all with
`useCallback: true`, at block 72,800,602. The 40 / 60 layout matches the
creator-fee example in the launcher's `DeployFeeSplitter` script.

The two creator-fee splitters differ in one way that matters: `0xeFF1...ACDf`
pays the v3.2.0 vault, which the VestingClaimRecipient allowlists, so its
creator share can go to the vesting route. `0x9411...449C` pays the v3.3.0
vault, which it does not allowlist, so that share can never vest.

The plan matches the v3.3.0 recipients first and the v3.2.0 recipients second,
and names every deployed splitter that fits. A vesting share always goes to the
v3.2.0 vault, so `vesting=40/0,compounding=60/100` matches `0xeFF1...ACDf`.

The plan reports the release of its split recipients as
`feeSplitter.recipientRelease`. It is null when the splits mix the two
releases, for example the v3.3.0 vault with the v3.2.0 vesting vault, or a
v3.3.0 recipient with BuybackAndBurnClaimRecipient, which is listed only as
v3.2.0. No published FeeSplitter mixes releases, so a null release always
needs a new FeeSplitter.

## Recipients

### UERC20BeneficiaryVault (`vault`)

- Holds the creator's share. Registering a position mints a transferable
  "Fee Beneficiary" (FEEB) ERC-721 with the position's id, and only its holder
  can claim. Transferring the NFT transfers the whole future stream.
- A position is registered once. Registration is authorized by custody of the
  position (`BeneficiaryVault.sol:38`, `UERC20BeneficiaryVault.sol:48`;
  `TechnicalReference.md:110`), so the owner registers before moving the
  position into the FeeSplitter. The creator of a launcher-created UERC20
  token can also register later, proven through the token's `graffiti()`
  (`UERC20BeneficiaryVault.sol:52`).
- For a CCA launch this means `positionRecipient` must be the creator's own
  address, not the FeeSplitter. That address receives the full-range fallback
  (`PositionPlanner.sol:172` at `1c59049`) and every planned position whose
  `overridePositionRecipient` is `address(0)`. A nonzero override replaces it
  for that position (`PositionPlanner.sol:148-155`; the field is
  `PositionPlannerTypes.sol:16`, and `MigratorParams.sol:27` describes the
  default). `PositionPlanner.validate` rejects only `address(1)` and
  `address(2)` as overrides (`PositionPlanner.sol:66-72`). So every override
  must be `address(0)` or the creator. A position minted anywhere else stays
  with that address. The creator cannot move it into the FeeSplitter, so its
  fees stay outside the split, and cannot register it through custody. The
  creator registers each position, then transfers each one to the FeeSplitter.
- Until that transfer the creator owns the positions and can remove all of
  their liquidity. The v4 PositionManager lets the owner or an approved
  address decrease or burn a position (`PositionManager.sol:156-159`,
  `:332-338` and `:407-409` in `v4-periphery` at `ad04c9f`, the submodule
  pinned by `1c59049`). No contract forces the transfer, so check that the
  FeeSplitter holds every position before relying on the split.
- An unregistered position whose tokens have no graffiti pays out to the
  vault's fallbacks (`BeneficiaryVault.sol:56-59`). On chain, both vaults have
  `nativeFallback` `0x2aC03e14Cfe755426DaAEe0a4994184Ce81482F8` (the TokenJar
  the deploy parameters name for Robinhood Chain) and `tokenFallback` the burn
  address `0x000000000000000000000000000000000000dEaD`.
- The source warns against pools that pair two tokens that both expose
  `graffiti()`, because either creator could claim both sides
  (`UERC20BeneficiaryVault.sol:16-18`).
- Claiming needs no executor contract.

### CompoundingClaimRecipient (`compounding`)

- Pays the attributed amounts to whichever caller runs `claim`. That caller
  must be a contract implementing `IClaimExecutor`
  (`BaseClaimRecipientWithCallback.sol:27`), and by the end of the call the
  position's liquidity must have grown by at least `minLiquidityIncrease`
  (`CompoundingClaimRecipient.sol:40-46`), read on chain as
  `100000000000000000000` (1e20) for both releases.
- The executor keeps whatever it does not spend on that increase, so the
  compounding share does not all return to the pool.
- It compounds only inside the position's existing range. If a boundary tick
  of that range holds the maximum liquidity per tick, every claim on the
  position reverts (`CompoundingClaimRecipient.sol:10-12`).

### BuybackAndBurnClaimRecipient (`buyback`)

- Pays the attributed amounts to a caller contract implementing
  `IClaimExecutor`, then pulls a fixed `minCurrency1BurnAmount` of the token
  from it and sends it to the burn address, in one transaction
  (`BuybackAndBurnClaimRecipient.sol:50-55` at `0b5ee05`).
- It assumes native ETH as `currency0` and a standard 18-decimal ERC-20 as
  `currency1` (`BuybackAndBurnClaimRecipient.sol:12`), and reverts unless
  `currency0` is native ETH (`:43-46`).
- The burn amount does not scale with what has accumulated. On chain it is
  `500000000000000000000000`, which the docs publish as 500,000 tokens (0.05%
  of supply) and which is 500,000 tokens only at 18 decimals.
- The plan reports the burn as a share of the stated supply, and lists a
  buyback or vesting share under `blocked` when the token does not use 18
  decimals or when one burn exceeds the whole supply.
- The contract does not check decimals (`BuybackAndBurnClaimRecipient.sol:50-55`
  pulls a fixed amount). At other decimals claims still succeed but burn a
  different number of tokens, 0.5 tokens at 24 decimals, so that entry says
  it does not work as designed. When one burn exceeds the supply, no claim
  can succeed.
- On Robinhood Chain the VestingClaimRecipient releases into it. A FeeSplitter
  can also name it directly (the Arc deployment does), which here would need a
  new splitter.

### VestingClaimRecipient (`vesting`)

- Not a direct FeeSplitter recipient. It holds beneficiary NFTs, pulls a
  position's share from an allowlisted vault with the permissionless
  `claimFrom`, and releases it with `claim` to one recipient fixed at
  deployment, capped per block and per position
  (`VestingClaimRecipient.sol:148-171` at `0b5ee05`). The first `claimFrom`
  starts the clock and unused capacity accrues.
- It only claims from vaults allowlisted in its constructor
  (`VestingClaimRecipient.sol:93-99`, checked at `:124`). It has no function
  that changes the list and none that returns a beneficiary NFT, so handing it
  one is permanent.
- It assumes the vault pays out the full amount it reports, so the token must
  not take a fee on transfer (`VestingClaimRecipient.sol:110-112`).
- On chain: `recipient` is BuybackAndBurnClaimRecipient
  `0xa1ba4CC12654D2b188e3ba77dc86c75cA47f1A4e`; `maxCurrency0PerBlock` is
  `125000000000000` (0.000125 ETH on a native-ETH pair); `maxCurrency1PerBlock`
  is `50000000000000000000000` (50,000 tokens at 18 decimals).
- The caps count blocks with `BlockNumberish` (`VestingClaimRecipient.sol:135`
  and `:157` at `0b5ee05`). It uses ArbSys `arbBlockNumber()` when the
  precompile at `0x64` answers at deployment (`BlockNumberish.sol:23-35` and
  `:39-56` at `38fe20b`, the submodule pinned by `0b5ee05`). On chain the deployed
  runtime holds that flag set to 1, and `arbBlockNumber()` returned
  72,828,184 at block 72,828,184, so the caps count ordinary Robinhood Chain
  blocks.
- Measured with `eth_getBlockByNumber` timestamps over the 1,000,000 blocks
  ending at block 72,828,184 (2026-09-26): 100,911 s, so 0.100911 s per
  block and 856,200 blocks per day. At that rate release capacity builds up
  at about 107.02 ETH on the native side and about 42.81 billion tokens (at
  18 decimals) on the token side, per position per day. `verify` repeats the
  measurement and reports it under `recipients.vesting.releasePerDay`.
- That rate is not a daily ceiling. A position's window opens at its first
  `claimFrom` (`VestingClaimRecipient.sol:134-136` at `0b5ee05`). Anyone can
  call `claim` (`BaseClaimRecipient.sol:59` at `0b5ee05`). A claim releases
  the smaller of what the contract holds for the position and the cap times
  the blocks since the window opened (`VestingClaimRecipient.sol:164-169`).
  The window restarts for both sides only when a claim finds an amount held
  on either side (`:156-160`), and capacity that claim did not use is lost.
  So capacity not used while nobody claims carries over: after two days with
  no claim (1,712,400 blocks at the rate above), one claim can release up to
  about 214 ETH if the contract holds that much.
- On chain, `isAllowlisted` is **true** for the v3.2.0 vault
  `0xd35E9CA72F64C7F93BE30fad67524323396B36D7` and **false** for the v3.3.0
  vault `0x26d2F7AcB07707034406a0dC458351Bb63C02553`. The plan therefore
  routes every vesting share to the v3.2.0 vault; through the v3.3.0 vault
  `claimFrom` would revert. `verify` re-reads both values.
- The route that works today: FeeSplitter `0xeFF1...ACDf` pays the v3.2.0
  vault; the position owner registers the position there with the
  VestingClaimRecipient as beneficiary before moving it into the splitter; the
  vesting contract then releases into buyback and burn.
- `vault` and `vesting` can share one plan only through two different vaults,
  the v3.3.0 vault for the creator and the v3.2.0 vault for vesting, each
  registered separately. No published splitter does this, so it needs a new
  FeeSplitter.

## Unconfirmed

- The docs describe the FeeSplitter only for Instant Launch positions. For a
  plan with a vault or vesting share, the CCA flow above (the creator
  receives the positions, registers them, then transfers them) follows
  `TechnicalReference.md:110` at `7ea523c`, which documents registering
  before the transfer to the FeeSplitter, but no official doc describes it
  for a CCA launch. For a plan with only compounding or buyback shares,
  naming a FeeSplitter as a CCA launch's `positionRecipient` passes the
  checks in the code read here (only the zero address, `address(1)` and
  `address(2)` are rejected, `MigratorParams.sol:119-122`), but it is not a
  documented flow.
- The deployments page lists no UERC20 token factory for Robinhood Chain, so
  registration through graffiti there is not confirmed. The UERC20Factory
  address it lists for Ethereum and Sepolia (v2.0.0, `de5bacd`),
  `0x000000e200088D55C39a11F609E5F667729ad49b`, has 13,380 bytes of code on
  Robinhood Chain at block 72,828,184, but that code was not compared with
  the published source.
- How fee value divides between the native and token sides depends on
  trading. The script gives a range unless the user states an assumption.
- The daily vesting rate uses the average block time of the last 1,000,000
  blocks. Later block times can differ; `verify` measures again on each run.
- The docs page on strategies still shows the pre-v3 `MigratorParameters`.
- The PositionManager behavior cited above comes from the `v4-periphery`
  source the launcher pins (`ad04c9f`). The deployed PositionManager
  `0x58daec3116aae6D93017bAAea7749052E8a04fA7` was not compared with that
  source.

## Sources

Uniswap `liquidity-launcher`, file paths under
`https://github.com/Uniswap/liquidity-launcher/blob/<commit>/`:

- `7ea523c9d75a51cb2f497be5e49bacdaeb80a342` (periphery v3.3.0):
  `src/periphery/FeeSplitter.sol`, `src/periphery/BeneficiaryVault.sol`,
  `src/periphery/UERC20BeneficiaryVault.sol`,
  `src/periphery/CompoundingClaimRecipient.sol`,
  `src/periphery/BaseClaimRecipient.sol`,
  `src/periphery/BaseClaimRecipientWithCallback.sol`,
  `src/interfaces/IFeeSplitter.sol`, `src/interfaces/IClaimableRecipient.sol`,
  `src/interfaces/IClaimExecutor.sol`, `src/periphery/README.md`,
  `docs/TechnicalReference.md`, `script/contracts/Parameters.sol`,
  `script/contracts/periphery/DeployFeeSplitter.s.sol`
- `dd8769cd45c0e9450e928513ee129b0af74f7f32` (periphery v3.2.0): the same
  periphery files, compared with the ones above
- `0b5ee0527af94a8c635b6af5b334a7d17c5ed719`:
  `src/periphery/VestingClaimRecipient.sol`,
  `src/periphery/BuybackAndBurnClaimRecipient.sol`,
  `src/periphery/BaseClaimRecipient.sol`
- `1c5904912aefceaceb89c24528cd5e25d0b61597` (LBPStrategy v3.3.0):
  `src/strategies/lbp/LBPStrategy.sol`, `src/libraries/MigratorParams.sol`,
  `src/libraries/PositionPlanner.sol`, `src/types/PositionPlannerTypes.sol`
- Legacy supply field: `src/types/MigratorParameters.sol` at `fd5be9b`
  (v1.0.0 candidate, `tokenSplitToAuction`) and `610603e` (v2.0.0,
  `tokenSplit`)

Uniswap `continuous-clearing-auction` at
`7d7602d257733315434570f2a0c2f94f1c7b207a`: `src/libraries/ConstantsLib.sol`,
`src/AuctionStorage.sol`, `src/ContinuousClearingAuctionFactory.sol`.

Submodules pinned by `liquidity-launcher`: Uniswap `blocknumberish` at
`38fe20bc0341d5bc2780d41f90dadb70e10f8cea` (`src/BlockNumberish.sol`, pinned
by `0b5ee05`) and Uniswap `v4-periphery` at
`ad04c9f24a170accf5ea1b2836bbafd514537ca6` (`src/PositionManager.sol`,
pinned by `1c59049`).

Uniswap developer docs, read 2026-09-26:

- https://developers.uniswap.org/docs/liquidity/liquidity-launchpad/deployments
- https://developers.uniswap.org/docs/liquidity/liquidity-launchpad/concepts/liquidity-strategies
- https://developers.uniswap.org/docs/liquidity/liquidity-launchpad/concepts/instant-launch
- https://developers.uniswap.org/docs/liquidity/liquidity-launchpad/guides/collect-and-compound-fees
- https://developers.uniswap.org/docs/liquidity/liquidity-launchpad/guides/buyback-and-burn

On chain: `eth_getCode` and `eth_call` against
`https://rpc.mainnet.chain.robinhood.com` (chainId 4663), block 72,800,602,
2026-09-26. The vesting clock, the block time and the UERC20Factory code
were read at block 72,828,184, the same day.
