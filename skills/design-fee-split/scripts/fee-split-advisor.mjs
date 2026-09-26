#!/usr/bin/env node

// Treasury specialist tooling: turns a fee-sharing intent into a Uniswap
// Liquidity Launchpad configuration on Robinhood Chain and checks the launchpad
// contracts on chain. It only reads and computes. It never signs, deploys or
// submits a transaction. Sources: references/splitter-recipients.md. The launchpad addresses
// and the on-chain check behind verify are in launchpad.mjs.

import { pathToFileURL } from "node:url";

import {
  BUYBACK,
  BUYBACK_BURN_PER_CLAIM,
  LAUNCHPAD_CONTRACTS,
  DEPLOYED_SPLITTERS,
  RELEASES,
  ROBINHOOD_CHAIN_ID,
  VAULT_V33,
  VESTING,
  VESTING_VAULT,
  formatUnits,
  prose,
  sameAddress,
  sameSplits,
  split,
  verify,
} from "./launchpad.mjs";

// The launchpad facts, for callers of this script.
export { DEPLOYED_SPLITTERS, LAUNCHPAD_CONTRACTS, ROBINHOOD_CHAIN_ID } from "./launchpad.mjs";

// Launchpad units: mps for supply shares (1e7 = 100%), basis points for fee
// shares (FeeSplitter.BPS_DENOMINATOR = 10_000).
const MPS_DECIMALS = 5;
const MPS_TOTAL = 10_000_000;
const BPS_DECIMALS = 2;
const BPS_TOTAL = 10_000;
const UINT256_LIMIT = 1n << 256n;
// ContinuousClearingAuction ConstantsLib.MAX_TOTAL_SUPPLY, enforced in the auction constructor.
const AUCTION_MAX_SUPPLY = 1n << 100n;
const MAX_FEES_USD = 1_000_000_000_000;
const DEFAULT_DECIMALS = 18;

const hop = (name, address, note) => (note ? { contract: name, address, note } : { contract: name, address });

const BUYBACK_REQUIRES = prose`The token must be a standard 18-decimal ERC-20: the BuybackAndBurnClaimRecipient
  assumes one, and every claim burns a fixed ${BUYBACK_BURN_PER_CLAIM} base units (500,000 tokens at 18 decimals),
  whatever has accumulated. verify re-reads that amount.`;

// Registration in a vault is authorized by custody of the position (BeneficiaryVault.registerBeneficiary).
// PositionPlanner.sol at 1c59049: a definition's overridePositionRecipient, when not address(0), replaces
// positionRecipient for that position (lines 148-155); only the full-range fallback always goes to
// positionRecipient (line 172). The field: PositionPlannerTypes.sol:16.
const CCA_REGISTRATION = prose`For a CCA launch, set positionRecipient to the creator's own address, not to the
  FeeSplitter, because registering a position in a vault needs custody of it. Leave every position definition's
  overridePositionRecipient at address(0) or set it to the creator: a nonzero override replaces positionRecipient
  for that position, and only the full-range fallback always goes to positionRecipient. A position minted to any
  other address stays with that address. The creator cannot move it into the FeeSplitter, so its fees stay
  outside the split, and cannot register it through custody. After migration the creator registers every minted
  position in the vault, then transfers each one to the FeeSplitter.`;
// v4-periphery PositionManager.sol at ad04c9f (pinned by 1c59049): decrease and burn need the owner or an
// approved caller (lines 156-159, 332-338, 407-409).
const CUSTODY_GAP = prose`From migration until the creator transfers the positions into the FeeSplitter, the
  creator owns them and can remove all of their liquidity, because the v4 PositionManager lets a position's owner
  decrease or burn it. No contract forces the transfer. Check that the FeeSplitter holds every position before
  relying on the split.`;
// FeeSplitter.collectFees reverts NotOwner for a position it does not hold (FeeSplitter.sol:66-68 at 7ea523c).
const SPLITTER_CUSTODY = prose`Every position must end up in the FeeSplitter, which collects fees only for
  positions it holds. For a CCA launch whose positionRecipient is the FeeSplitter, leave every position
  definition's overridePositionRecipient at address(0) or set it to the FeeSplitter: a nonzero override replaces
  positionRecipient for that position, and a position minted to any other address stays outside the split.`;
const UNREGISTERED_FALLBACK = prose`If the FeeSplitter holds an unregistered position and neither token carries
  graffiti, the vault pays this share to its fallbacks instead: the native side to nativeFallback (the TokenJar) and
  the token side to the burn address. verify reads both.`;

// Where each share lands and what it locks in. The splitter address is the one written
// into the FeeSplitter (splitterContract names it when it is not the share's own contract);
// the route is where the money goes next.
const RECIPIENTS = {
  vault: {
    contract: "UERC20BeneficiaryVault",
    role: "creator share",
    splitterAddress: (release) => release.vault,
    route: (release) => [hop("UERC20BeneficiaryVault", release.vault)],
    whoGetsIt: prose`The holder of the transferable Fee Beneficiary (FEEB) ERC-721 the vault mints for the
      position claims this share. Nobody else can claim it once the position is registered.`,
    locksIn: [
      prose`The FEEB NFT is transferable, so whoever holds it owns the whole future creator share. Selling it
        sells the fee stream.`,
      "A position's beneficiary is registered once. After that the only way to change it is to transfer the NFT.",
    ],
    requires: [
      prose`The creator can claim only after the position is registered in the vault. Registration is
        authorized by custody of the position, so its owner registers it before moving it into the FeeSplitter.
        The creator of a launcher-created UERC20 token can also register later through the token's graffiti.`,
      CCA_REGISTRATION,
      CUSTODY_GAP,
      UNREGISTERED_FALLBACK,
    ],
    unconfirmed: [
      prose`The deployments page lists no UERC20 token factory for Robinhood Chain, so registering through
        graffiti there is not confirmed. The UERC20Factory address it lists for Ethereum and Sepolia,
        0x000000e200088D55C39a11F609E5F667729ad49b, has 13,380 bytes of code on Robinhood Chain, but that code
        was not compared with the published source.`,
    ],
  },
  vesting: {
    contract: "VestingClaimRecipient",
    role: "creator share vested into buyback and burn",
    splitterContract: "UERC20BeneficiaryVault",
    splitterAddress: () => VESTING_VAULT,
    route: () => [
      hop("UERC20BeneficiaryVault", VESTING_VAULT,
        "the v3.2.0 vault, the published one the vesting contract allowlists"),
      hop("VestingClaimRecipient", VESTING,
        "holds the position's beneficiary NFT, releases a capped amount per block"),
      hop("BuybackAndBurnClaimRecipient", BUYBACK, "fixed downstream recipient of the vesting contract"),
    ],
    whoGetsIt: prose`The creator does not receive this share. The VestingClaimRecipient holds the position's
      beneficiary NFT, pulls the share from the vault with claimFrom and releases it, capped per block per
      position, into the BuybackAndBurnClaimRecipient.`,
    locksIn: [
      prose`Handing the beneficiary NFT to the VestingClaimRecipient is one way: the contract has no function
        that gives it back.`,
      prose`The per-block release caps, the allowlisted vaults and the downstream recipient were fixed when the
        vesting contract was deployed.`,
      // VestingClaimRecipient.sol at 0b5ee05: a claim releases min(held, cap * blocks since lastClaimed), and
      // lastClaimed moves only when a claim finds an amount held (lines 156-169), so unused capacity carries over.
      prose`The caps are 0.000125 ETH and 50,000 tokens (at 18 decimals) per block, per position, counted in
        ArbSys blocks. At the 0.1009 s block time measured on 2026-09-26, release capacity builds up at about 107
        ETH and 42.8 billion tokens per position per day. That is a rate, not a daily ceiling: capacity not used
        while nobody claims carries over, so one claim after a pause can release more. verify measures the block
        time again and reports the current rate, which may differ.`,
    ],
    requires: [
      prose`This share is paid to the v3.2.0 UERC20BeneficiaryVault at ${VESTING_VAULT}, the only published vault
        the VestingClaimRecipient allowlists. It does not allowlist the v3.3.0 vault at ${VAULT_V33}, so vesting
        through that vault would revert. Use this route only while verify reports
        recipients.vesting.allowlistsVestingVault true.`,
      prose`The position owner registers each position in that vault with the VestingClaimRecipient as
        beneficiary, or registers itself and transfers the FEEB NFT to it, before moving the position into the
        FeeSplitter.`,
      CCA_REGISTRATION,
      CUSTODY_GAP,
      UNREGISTERED_FALLBACK,
      prose`The token must not take a fee on transfer: the vesting contract requires the vault to pay out the
        full amount it reports.`,
      BUYBACK_REQUIRES,
    ],
    unconfirmed: [],
  },
  compounding: {
    contract: "CompoundingClaimRecipient",
    role: "compounding into the locked position",
    splitterAddress: (release) => release.compounding,
    route: (release) => [hop("CompoundingClaimRecipient", release.compounding)],
    whoGetsIt: prose`Paid to whichever executor contract calls claim (a plain wallet cannot). In the same call it
      must add at least minLiquidityIncrease of liquidity to the locked position, and it keeps whatever it does
      not need for that.`,
    locksIn: [
      "The minimum liquidity increase per claim was fixed when the recipient was deployed.",
      prose`Compounding only adds liquidity inside the position's existing range. If a boundary tick of that
        range reaches the maximum liquidity per tick, every claim on the position reverts.`,
    ],
    requires: [],
    unconfirmed: [],
  },
  buyback: {
    contract: "BuybackAndBurnClaimRecipient",
    role: "buyback and burn",
    splitterAddress: () => BUYBACK,
    route: () => [hop("BuybackAndBurnClaimRecipient", BUYBACK)],
    whoGetsIt: prose`Paid to whichever executor contract calls claim (a plain wallet cannot). In the same call it
      must send a fixed minCurrency1BurnAmount of the token to the burn address, and it keeps whatever is left.`,
    locksIn: [
      prose`The burn amount per claim was fixed when the recipient was deployed and does not scale with what has
        accumulated.`,
    ],
    requires: [BUYBACK_REQUIRES],
    unconfirmed: [],
  },
};

// Accepts each short key and each contract name, in any case.
const RECIPIENT_ALIASES = Object.fromEntries(
  Object.entries(RECIPIENTS).flatMap(([key, recipient]) => [[key, key], [recipient.contract.toLowerCase(), key]]),
);

// Shares whose value ends in the BuybackAndBurnClaimRecipient.
const BURNING_SHARES = ["buyback", "vesting"];
// Shares paid through a vault, which needs each position registered while the creator holds it.
const REGISTERING_SHARES = ["vault", "vesting"];

const GENERAL_LOCKS = [
  prose`The FeeSplitter holds every position it receives permanently. It has no function that gives one back;
    the only actions left are collecting fees and adding liquidity.`,
  prose`The FeeSplitter shares are set when it is deployed and can never change. Whoever calls collectFees
    cannot redirect them.`,
  prose`The auction and pool token amounts are fixed when initializeDistribution runs: the LBPStrategy stores its
    migration parameters then and has no function that changes them.`,
];

// FeeSplitter.sol, identical at 7ea523c (v3.3.0) and dd8769c (v3.2.0): onERC721Received checks only
// that the caller is the PositionManager (lines 118-121); increaseLiquidity and _collect revert with
// InvalidBaseCurrency when currency0 is not native ETH (lines 89 and 154).
const GENERAL_REQUIRES = [
  prose`The pool must pair native ETH, as currency0, with the token. The FeeSplitter does not refuse other
    positions: it takes any position the PositionManager delivers and never gives one back, and it checks the
    currency only when it collects fees or adds liquidity, both of which revert unless currency0 is native ETH.
    A position paired with an ERC-20 as currency0 would be locked in the splitter forever with its fees
    uncollectable. In a CCA launch the pool pairs the raised currency with the token, so the auction must raise
    native ETH.`,
  prose`The token must be a standard, unrestricted token, as the launchpad's periphery documentation requires for
    the FeeSplitter.`,
  "The FeeSplitter does not support positions whose pool hook needs hookData.",
];

const GENERAL_UNCONFIRMED = [
  prose`The official docs describe the FeeSplitter for Instant Launch positions. Pointing a CCA launch's
    positions at a FeeSplitter is allowed by the LBPStrategy and FeeSplitter code read for this skill, but it
    is not a documented flow.`,
];
// Replaces GENERAL_UNCONFIRMED when a share is paid through a vault (TechnicalReference.md:110 at 7ea523c).
const REGISTRATION_UNCONFIRMED = [
  prose`The official docs describe the FeeSplitter for Instant Launch positions. For a CCA launch this plan has
    the creator receive the positions, register them in the vault, then transfer them to the FeeSplitter. The
    launcher's TechnicalReference.md documents registering before that transfer, but no official doc describes
    this flow for a CCA launch.`,
];

const NOTICE = "Analysis only. Nothing was signed, deployed or submitted.";

const FORBIDDEN_FLAGS = ["--execute", "--deploy", "--sign", "--send", "--submit", "--broadcast"];

function usage() {
  return [
    "Usage:",
    "  fee-split-advisor.mjs verify",
    "  fee-split-advisor.mjs plan --auction-pct <n> --shares <recipient>=<pct>[/<tokenPct>],...",
    "                             [--fees-usd <n>] [--native-fee-pct <n>]",
    "                             [--total-supply <whole tokens>] [--decimals <n>]",
    "",
    "Recipients: vault, compounding, buyback, vesting.",
    "A single percentage applies to both fee sides; <native>/<token> sets them separately.",
    "--decimals defaults to 18. When it is not given, missing says so if the supply or a burn share used it.",
    "Analysis only: this tool never signs, deploys or submits a transaction.",
  ].join("\n");
}

function parseFlags(args, allowed) {
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument "${token}".\n${usage()}`);
    }
    const equals = token.indexOf("=");
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    if (!allowed.includes(name)) {
      throw new Error(`Unknown option --${name}.\n${usage()}`);
    }
    if (Object.hasOwn(flags, name)) {
      throw new Error(`--${name} was given more than once.`);
    }
    let value;
    if (equals === -1) {
      value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`--${name} needs a value.`);
      }
      index += 1;
    } else {
      value = token.slice(equals + 1);
    }
    flags[name] = value.trim();
  }
  return flags;
}

// Parses a plain decimal percentage into integer units of 10^-decimals percent,
// so 55 becomes 5_500_000 mps (decimals 5) and 40 becomes 4_000 bps (decimals 2).
function parsePercent(label, value, decimals) {
  if (typeof value !== "string" || !/^\d{1,3}(\.\d+)?$/.test(value)) {
    throw new Error(`${label} must be a plain number from 0 to 100, got "${value}".`);
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw new Error(`${label} allows at most ${decimals} decimal places, got "${value}".`);
  }
  const scale = 10 ** decimals;
  const units = Number(whole) * scale + Number(fraction.padEnd(decimals, "0"));
  if (units > 100 * scale) {
    throw new Error(`${label} must be at most 100, got "${value}".`);
  }
  return units;
}

function formatPercent(units, decimals) {
  const scale = 10 ** decimals;
  const whole = Math.floor(units / scale);
  const fraction = String(units % scale).padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

// amount as a percentage of total, rounded down to 6 decimal places.
function formatShareOfSupply(amount, total) {
  const scaled = (amount * 100n * 10n ** 6n) / total;
  return scaled === 0n ? "less than 0.000001" : formatUnits(scaled, 6);
}

function formatUsd(value) {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const toCents = (value) => Math.round(value * 100) / 100;

function parseDecimals(flags) {
  if (flags.decimals === undefined) return { value: DEFAULT_DECIMALS, given: false };
  if (!/^\d{1,2}$/.test(flags.decimals) || Number(flags.decimals) > 36) {
    throw new Error(`--decimals must be a whole number from 0 to 36, got "${flags.decimals}".`);
  }
  return { value: Number(flags.decimals), given: true };
}

const decimalsSource = (decimals) => (decimals.given ? "given" : "default 18, not given");

function planAuction(flags, decimals) {
  if (flags["auction-pct"] === undefined) {
    throw new Error(`--auction-pct is required: the share of total supply sold in the CCA auction.\n${usage()}`);
  }
  const mps = parsePercent("--auction-pct", flags["auction-pct"], MPS_DECIMALS);
  if (mps === 0 || mps === MPS_TOTAL) {
    throw new Error(prose`--auction-pct must be above 0 and below 100. The LBPStrategy needs both a nonzero
      auction supply and a nonzero LP reserve. A launch with no auction is an Instant Launch, whose supply and fee
      split are fixed by the chosen deployment.`);
  }

  const supply = planSupply(flags, mps, decimals);
  const auction = {
    auctionPct: formatPercent(mps, MPS_DECIMALS),
    lpReservePct: formatPercent(MPS_TOTAL - mps, MPS_DECIMALS),
    auctionShareMps: mps,
    unit: "mps (1e7 = 100%)",
    auctionShareNote: prose`The deployed LBPStrategy v3.3.0 has no share field. It takes reservedTokenAmountForLP,
      an absolute token amount, and sends totalSupply minus that amount to the auction. The docs' strategies page
      and the original LBP strategy call the share tokenSplitToAuction; do not pass that name to the deployed
      contract.`,
    ...(supply ? supply.output : { reservedTokenAmountForLP: null, auctionSupply: null }),
    lpNote: prose`How much of the raised currency goes into the pool is set separately by lpAllocationSchedule.
      This tool does not design it.`,
  };
  const missing = supply
    ? []
    : ["--total-supply: without it reservedTokenAmountForLP and the auction supply cannot be computed."];
  return { auction, supply, missing };
}

// Turns the auction share into the absolute amounts the deployed LBPStrategy
// takes: the auction gets floor(totalSupply * mps / 1e7), the LP keeps the rest.
function planSupply(flags, mps, decimals) {
  if (flags["total-supply"] === undefined) return null;
  const supplyText = flags["total-supply"];
  if (!/^[1-9]\d{0,77}$/.test(supplyText)) {
    throw new Error(`--total-supply must be a whole number of tokens greater than 0, got "${supplyText}".`);
  }
  const totalSupply = BigInt(supplyText) * 10n ** BigInt(decimals.value);
  if (totalSupply >= UINT256_LIMIT) {
    throw new Error("--total-supply does not fit in a uint256 at these decimals.");
  }
  const auctionSupply = (totalSupply * BigInt(mps)) / BigInt(MPS_TOTAL);
  const reserved = totalSupply - auctionSupply;
  if (auctionSupply === 0n) {
    throw new Error("The auction would receive zero tokens at this supply and share. Raise either value.");
  }
  // The auction gets at least 1e-7 of the supply, so this cap also keeps the
  // reserve below the int128 limit the LBPStrategy enforces.
  if (auctionSupply > AUCTION_MAX_SUPPLY) {
    throw new Error(prose`The auction would receive ${auctionSupply} base units, above the ${AUCTION_MAX_SUPPLY}
      (2^100) a ContinuousClearingAuction accepts. Lower --total-supply or --auction-pct.`);
  }
  return {
    totalSupply,
    output: {
      totalSupply: totalSupply.toString(),
      decimals: decimals.value,
      decimalsSource: decimalsSource(decimals),
      reservedTokenAmountForLP: reserved.toString(),
      reservedTokens: formatUnits(reserved, decimals.value),
      auctionSupply: auctionSupply.toString(),
      auctionTokens: formatUnits(auctionSupply, decimals.value),
    },
  };
}

function parseShares(value) {
  if (value === undefined || value === "") {
    throw new Error(`--shares is required, for example --shares vault=40/0,compounding=60/100.\n${usage()}`);
  }
  const shares = [];
  for (const rawEntry of value.split(",")) {
    const entry = rawEntry.trim();
    const match = /^([A-Za-z0-9]+)=([^=]+)$/.exec(entry);
    if (!match) {
      throw new Error(`Cannot read the share "${entry}". Write <recipient>=<pct> or <recipient>=<native>/<token>.`);
    }
    const key = RECIPIENT_ALIASES[match[1].toLowerCase()];
    if (!key) {
      throw new Error(`Unknown recipient "${match[1]}". Use one of: ${Object.keys(RECIPIENTS).join(", ")}.`);
    }
    if (shares.some((share) => share.key === key)) {
      throw new Error(`Recipient "${key}" appears twice in --shares. The FeeSplitter rejects duplicate recipients.`);
    }
    const sides = match[2].split("/").map((side) => side.trim());
    if (sides.length > 2) {
      throw new Error(`Cannot read the share "${entry}". Use at most one "/" between the native and token sides.`);
    }
    const nativeBps = parsePercent(`${key} native share`, sides[0], BPS_DECIMALS);
    const tokenBps = parsePercent(`${key} token share`, sides[1] ?? sides[0], BPS_DECIMALS);
    if (nativeBps === 0 && tokenBps === 0) {
      throw new Error(`${key} has 0% on both sides. The FeeSplitter rejects a split with no share; drop it instead.`);
    }
    shares.push({ key, nativeBps, tokenBps });
  }

  for (const side of ["native", "token"]) {
    const total = shares.reduce((sum, share) => sum + share[`${side}Bps`], 0);
    if (total !== BPS_TOTAL) {
      const pct = formatPercent(total, BPS_DECIMALS);
      throw new Error(`The ${side} side shares add up to ${pct}%. Each side must add up to exactly 100%.`);
    }
  }
  return shares;
}

// What paying a given vault means for a later move to the vesting route.
function vaultNote(recipients) {
  if (recipients.some((address) => sameAddress(address, VESTING_VAULT))) {
    return prose`Pays the v3.2.0 vault, which the VestingClaimRecipient allowlists, so the vault's share can go to
      the vesting route.`;
  }
  if (recipients.some((address) => sameAddress(address, VAULT_V33))) {
    return prose`Pays the v3.3.0 vault, which the VestingClaimRecipient does not allowlist, so the vault's share can
      never go to the vesting route.`;
  }
  return null;
}

// The published release shared by every recipient in the splits, or null when they span releases.
function releaseOfSplits(splits) {
  const versionOf = (entry) =>
    LAUNCHPAD_CONTRACTS.find((known) => sameAddress(known.address, entry.recipient))?.version ?? null;
  const versions = new Set(splits.map(versionOf));
  return versions.size === 1 ? [...versions][0] : null;
}

function describeDeployed({ address, version, label, splits }) {
  const note = vaultNote(splits.map((entry) => entry.recipient));
  return note ? { address, version, label, note } : { address, version, label };
}

// Builds the split list for each release, drops a list that would name one vault
// twice, and prefers the first list that matches a deployed FeeSplitter.
function chooseSplitter(shares) {
  const splitsFor = (release) =>
    shares.map(({ key, nativeBps, tokenBps }) => split(RECIPIENTS[key].splitterAddress(release), nativeBps, tokenBps));
  const distinct = (splits) => new Set(splits.map((entry) => entry.recipient.toLowerCase())).size === splits.length;
  const candidates = RELEASES.map((release) => ({ release, splits: splitsFor(release) }))
    .filter(({ splits }) => distinct(splits));
  const matches = candidates.flatMap((candidate) =>
    DEPLOYED_SPLITTERS.filter((deployed) => sameSplits(deployed.splits, candidate.splits))
      .map((deployed) => ({ candidate, deployed })),
  );
  return { chosen: matches[0]?.candidate ?? candidates[0], matches };
}

function describeMoney(shares, flags) {
  const missing = [];
  if (flags["fees-usd"] === undefined) {
    if (flags["native-fee-pct"] !== undefined) {
      throw new Error("--native-fee-pct only applies together with --fees-usd.");
    }
    missing.push("--fees-usd: without an assumed fee volume the split cannot be explained in money.");
    return { money: null, missing };
  }

  const feesText = flags["fees-usd"];
  if (!/^\d+(\.\d{1,2})?$/.test(feesText) || Number(feesText) <= 0 || Number(feesText) > MAX_FEES_USD) {
    throw new Error(`--fees-usd must be a positive amount in USD with at most 2 decimals, got "${feesText}".`);
  }
  const feesUsd = Number(feesText);
  const nativeFeeBps =
    flags["native-fee-pct"] === undefined
      ? null
      : parsePercent("--native-fee-pct", flags["native-fee-pct"], BPS_DECIMALS);

  const perRecipient = shares.map((share) => {
    const recipient = RECIPIENTS[share.key];
    const base = { share: share.key, contract: recipient.contract, role: recipient.role };
    if (share.nativeBps === share.tokenBps) {
      return { ...base, usd: toCents((feesUsd * share.nativeBps) / BPS_TOTAL), exact: true };
    }
    if (nativeFeeBps !== null) {
      const weighted = nativeFeeBps * share.nativeBps + (BPS_TOTAL - nativeFeeBps) * share.tokenBps;
      return { ...base, usd: toCents((feesUsd * weighted) / (BPS_TOTAL * BPS_TOTAL)), exact: false };
    }
    return {
      ...base,
      usd: null,
      usdIfAllFeesNative: toCents((feesUsd * share.nativeBps) / BPS_TOTAL),
      usdIfAllFeesToken: toCents((feesUsd * share.tokenBps) / BPS_TOTAL),
    };
  });

  const unevenShare = shares.some((share) => share.nativeBps !== share.tokenBps);
  if (unevenShare && nativeFeeBps === null) {
    missing.push(prose`--native-fee-pct: some shares differ between the native and token sides, so their value
      depends on how fees divide between the two sides, which only trading will show.`);
  }

  const lines = [
    nativeFeeBps === null
      ? `Per ${formatUsd(feesUsd)} USD of fees:`
      : prose`Per ${formatUsd(feesUsd)} USD of fees, assuming ${formatPercent(nativeFeeBps, BPS_DECIMALS)}% of the
          fee value accrues on the native side:`,
  ];
  for (const entry of perRecipient) {
    const who = `${entry.contract} (${entry.role})`;
    if (entry.usd !== null) {
      lines.push(`${who} gets ${formatUsd(entry.usd)} USD.`);
    } else {
      const low = formatUsd(Math.min(entry.usdIfAllFeesNative, entry.usdIfAllFeesToken));
      const high = formatUsd(Math.max(entry.usdIfAllFeesNative, entry.usdIfAllFeesToken));
      lines.push(prose`${who} gets between ${low} and ${high} USD, depending on how fees divide between the
        native and token sides.`);
    }
  }

  return {
    money: {
      feesUsd,
      nativeFeePct: nativeFeeBps === null ? null : formatPercent(nativeFeeBps, BPS_DECIMALS),
      basis: "Arithmetic on the fee volume the user assumed, not a forecast.",
      sides: prose`The FeeSplitter splits the native side and the token side separately. The mix between the two
        depends on trading.`,
      perRecipient,
      lines,
    },
    missing,
  };
}

function burnPerClaim(decimals, supply) {
  return {
    baseUnits: BUYBACK_BURN_PER_CLAIM.toString(),
    tokens: formatUnits(BUYBACK_BURN_PER_CLAIM, decimals.value),
    decimalsSource: decimalsSource(decimals),
    pctOfSupply: supply ? formatShareOfSupply(BUYBACK_BURN_PER_CLAIM, supply.totalSupply) : null,
  };
}

// Configurations that do not work as designed with the contracts deployed today.
function findBlocked(shares, decimals, supply) {
  const burning = shares.map((share) => share.key).filter((key) => BURNING_SHARES.includes(key));
  if (burning.length === 0) return [];
  const blocked = [];
  if (decimals.value !== DEFAULT_DECIMALS) {
    blocked.push({
      shares: burning,
      reason: prose`This does not work as designed. The deployed BuybackAndBurnClaimRecipient assumes an
        18-decimal token and burns a fixed ${BUYBACK_BURN_PER_CLAIM} base units per claim. At ${decimals.value}
        decimals that is ${formatUnits(BUYBACK_BURN_PER_CLAIM, decimals.value)} tokens per claim, not 500,000.`,
    });
  }
  if (supply && BUYBACK_BURN_PER_CLAIM > supply.totalSupply) {
    blocked.push({
      shares: burning,
      reason: prose`Every buyback claim must burn ${BUYBACK_BURN_PER_CLAIM} base units, more than the whole supply
        of ${supply.totalSupply} base units, so no claim could ever succeed.`,
    });
  }
  return blocked;
}

function plan(args) {
  const flags = parseFlags(args, ["auction-pct", "shares", "fees-usd", "native-fee-pct", "total-supply", "decimals"]);
  const decimals = parseDecimals(flags);
  const { auction, supply, missing: auctionMissing } = planAuction(flags, decimals);
  const shares = parseShares(flags.shares);
  const { money, missing: moneyMissing } = describeMoney(shares, flags);
  const { chosen, matches } = chooseSplitter(shares);
  const deployed = matches[0]?.deployed ?? null;
  const keys = shares.map((share) => share.key);

  const requires = [
    ...GENERAL_REQUIRES,
    deployed
      ? prose`These shares match the ${deployed.version} FeeSplitter already deployed at ${deployed.address}
          (${deployed.label}). Run verify to confirm its on-chain splits before relying on it.`
      : prose`No published FeeSplitter on Robinhood Chain has these shares. Using them needs a new FeeSplitter
          deployment, which this desk never does: a human deploys it and its address is verified before launch.`,
  ];
  if (keys.includes("vault") && keys.includes("vesting")) {
    requires.push(prose`vault and vesting use two different vaults here: ${chosen.release.vault} for the creator
      and ${VESTING_VAULT} for vesting. The position owner registers each position in both before moving it into
      the FeeSplitter, naming the creator in the first and the VestingClaimRecipient in the second.`);
  }
  const registers = keys.some((key) => REGISTERING_SHARES.includes(key));
  if (!registers) requires.push(SPLITTER_CUSTODY);
  const unconfirmed = [...(registers ? REGISTRATION_UNCONFIRMED : GENERAL_UNCONFIRMED)];
  for (const share of shares) {
    for (const line of RECIPIENTS[share.key].requires) if (!requires.includes(line)) requires.push(line);
    unconfirmed.push(...RECIPIENTS[share.key].unconfirmed);
  }

  const missing = [...auctionMissing, ...moneyMissing];
  const assumedFor = [
    ...(supply ? ["the token amounts"] : []),
    ...(keys.some((key) => BURNING_SHARES.includes(key)) ? ["the buyback burn"] : []),
  ];
  if (!decimals.given && assumedFor.length > 0) {
    missing.push(`--decimals: not given, so 18 was assumed for ${assumedFor.join(" and ")}.`);
  }

  const { splits } = chosen;
  return {
    chainId: ROBINHOOD_CHAIN_ID,
    mode: "analysis-only",
    input: { ...flags },
    auction,
    feeSplitter: {
      recipientRelease: releaseOfSplits(splits),
      splits,
      nativeBpsTotal: splits.reduce((sum, entry) => sum + entry.nativeBps, 0),
      tokenBpsTotal: splits.reduce((sum, entry) => sum + entry.tokenBps, 0),
      useCallbackReason: prose`Every launchpad recipient attributes fees per position only when the FeeSplitter
        notifies it. Without the callback, attribution is left to whoever calls first.`,
      deployed: deployed ? describeDeployed(deployed) : null,
      otherDeployedMatches: matches.slice(1).map((match) => describeDeployed(match.deployed)),
      needsNewDeployment: !deployed,
    },
    shares: shares.map((share) => {
      const recipient = RECIPIENTS[share.key];
      const address = recipient.splitterAddress(chosen.release);
      return {
        share: share.key,
        nativePct: formatPercent(share.nativeBps, BPS_DECIMALS),
        tokenPct: formatPercent(share.tokenBps, BPS_DECIMALS),
        nativeBps: share.nativeBps,
        tokenBps: share.tokenBps,
        splitterRecipient: hop(recipient.splitterContract ?? recipient.contract, address),
        route: recipient.route(chosen.release),
        whoGetsIt: recipient.whoGetsIt,
        locksIn: share.key === "vault" ? [...recipient.locksIn, vaultNote([address])] : recipient.locksIn,
        ...(BURNING_SHARES.includes(share.key) ? { burnPerClaim: burnPerClaim(decimals, supply) } : {}),
      };
    }),
    money,
    locksIn: registers ? [...GENERAL_LOCKS, CUSTODY_GAP] : GENERAL_LOCKS,
    requires,
    blocked: findBlocked(shares, decimals, supply),
    unconfirmed,
    missing,
    notice: NOTICE,
  };
}

export async function runCli({ argv, env = process.env, fetchImpl = fetch, write = (output) => console.log(output) }) {
  const forbidden = argv.find((arg) => FORBIDDEN_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
  if (forbidden) {
    throw new Error(prose`${forbidden.split("=")[0]} is not available. This tool only analyzes: it never signs,
      deploys or submits a transaction.`);
  }

  const [command = "help", ...args] = argv;
  if (command === "plan") {
    write(JSON.stringify(plan(args), null, 2));
    return;
  }
  if (command === "verify") {
    parseFlags(args, []);
    write(JSON.stringify(await verify(env, fetchImpl), null, 2));
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    write(usage());
    return;
  }
  throw new Error(usage());
}

const launchedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (launchedDirectly) {
  runCli({ argv: process.argv.slice(2) }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}