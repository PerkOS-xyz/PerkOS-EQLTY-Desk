// Robinhood Chain launchpad facts for the Treasury specialist: the Uniswap Liquidity Launchpad
// deployments, the FeeSplitters already deployed with their published splits, and the read-only
// on-chain check behind `fee-split-advisor.mjs verify`. It only reads. It never signs, deploys or
// submits a transaction. Sources: references/splitter-recipients.md.

export const ROBINHOOD_CHAIN_ID = 4663;
const DEFAULT_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";

export const VAULT_V33 = "0x26d2F7AcB07707034406a0dC458351Bb63C02553";
const VAULT_V32 = "0xd35E9CA72F64C7F93BE30fad67524323396B36D7";
const COMPOUNDING_V33 = "0xf585b5D728A8fdE743027307BF5F3556E3B9C58D";
const COMPOUNDING_V32 = "0xf9526Dd3361fe0ba6b7a99533ed471D3E808E99a";
export const BUYBACK = "0xa1ba4CC12654D2b188e3ba77dc86c75cA47f1A4e";
export const VESTING = "0xeF451B293ED8C61d20f7d13ef336a496F0cc2c26";
// The only published vault the VestingClaimRecipient allowlists; verify re-reads isAllowlisted for both vaults.
export const VESTING_VAULT = VAULT_V32;
// BuybackAndBurnClaimRecipient.minCurrency1BurnAmount, fixed at deployment; verify re-reads it.
export const BUYBACK_BURN_PER_CLAIM = 500_000n * 10n ** 18n;
// ArbSys precompile and arbBlockNumber(), which BlockNumberish (38fe20b, pinned by 0b5ee05) uses to count blocks.
const ARB_SYS = "0x0000000000000000000000000000000000000064";
const ARB_BLOCK_NUMBER = "0xa3b1b31d";
// BlockNumberish._getBlockNumberish compiles to PUSH32 <_USE_ARB_SYS> ISZERO PUSH2 <dest> JUMPI PUSH4 0xa3b1b31d.
// The deployed VestingClaimRecipient holds it once, with the flag set to 1.
const ARB_SYS_FLAG = /7f0{62}(0[01])1561[0-9a-f]{4}5763a3b1b31d/g;
// Blocks between the two timestamps verify reads to measure the block time.
const BLOCK_TIME_WINDOW = 1_000_000n;
const SECONDS_PER_DAY = 86_400n;

// Template tag for long messages: joins the parts and collapses line breaks and indentation into single spaces.
export const prose = (strings, ...values) =>
  strings.reduce((out, part, index) => out + part + (index < values.length ? values[index] : ""), "")
    .replace(/\s+/g, " ")
    .trim();

const contract = (name, version, address) => ({ name, version, address });

// Robinhood Chain launchpad deployments as published by Uniswap.
export const LAUNCHPAD_CONTRACTS = [
  contract("ContinuousClearingAuctionFactory", "v2.1.0", "0x000000001F26a0044BaA66024e7b6599c61963F8"),
  contract("LiquidityLauncher", "v3.2.0", "0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0"),
  contract("LBPStrategy", "v3.3.0", "0xbf1aB81f7d534b2CC0Da76fcf4d541322bB0e000"),
  contract("TokenSplitter", "v3.2.0", "0x4F5E3FBb9745358A92Da5674305FAb8D2B8a73cE"),
  contract("FeeSplitter (creator fee)", "v3.3.0", "0x9411fa7F956f64aa7981AA27cB3bC6eC0415449C"),
  contract("FeeSplitter (no creator fee)", "v3.3.0", "0x882Ae5e2095435A62Fd1BBDEfcb637f5CeAFc0ee"),
  contract("FeeSplitter (creator fee)", "v3.2.0", "0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf"),
  contract("FeeSplitter (no creator fee)", "v3.2.0", "0x222D6d4f1ce59b0d48D5505114eC8Addc90A4359"),
  contract("UERC20BeneficiaryVault", "v3.3.0", VAULT_V33),
  contract("UERC20BeneficiaryVault", "v3.2.0", VAULT_V32),
  contract("CompoundingClaimRecipient", "v3.3.0", COMPOUNDING_V33),
  contract("CompoundingClaimRecipient", "v3.2.0", COMPOUNDING_V32),
  contract("BuybackAndBurnClaimRecipient", "v3.2.0", BUYBACK),
  contract("VestingClaimRecipient", null, VESTING),
  contract("UniversalRouterStrategy", "v3.3.0", "0x0A122717bc36E3C7A7958128a5C789E0b070b3Ae"),
  contract("InitializerHook", "v3.3.0", "0x5fB5229FBA341dFE5a7e6A14d4809D6Cf887a000"),
];

export const split = (recipient, nativeBps, tokenBps) => ({ recipient, nativeBps, tokenBps, useCallback: true });
const splitter = (address, version, label, splits) => ({ address, version, label, splits });

// FeeSplitters already deployed on Robinhood Chain, with their published splits.
export const DEPLOYED_SPLITTERS = [
  splitter("0x9411fa7F956f64aa7981AA27cB3bC6eC0415449C", "v3.3.0", "creator fee", [
    split(VAULT_V33, 4_000, 0),
    split(COMPOUNDING_V33, 6_000, 10_000),
  ]),
  splitter("0x882Ae5e2095435A62Fd1BBDEfcb637f5CeAFc0ee", "v3.3.0", "no creator fee", [
    split(COMPOUNDING_V33, 10_000, 10_000),
  ]),
  splitter("0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf", "v3.2.0", "creator fee", [
    split(VAULT_V32, 4_000, 0),
    split(COMPOUNDING_V32, 6_000, 10_000),
  ]),
  splitter("0x222D6d4f1ce59b0d48D5505114eC8Addc90A4359", "v3.2.0", "no creator fee", [
    split(COMPOUNDING_V32, 10_000, 10_000),
  ]),
];

// The vault and compounding recipients exist in two published releases. The plan prefers
// v3.3.0 and uses v3.2.0 when only that release matches a deployed FeeSplitter.
export const RELEASES = [
  { release: "v3.3.0", vault: VAULT_V33, compounding: COMPOUNDING_V33 },
  { release: "v3.2.0", vault: VAULT_V32, compounding: COMPOUNDING_V32 },
];

// Selectors of the read-only functions verify calls.
const SELECTORS = {
  getSplits: "0x520db906", // getSplits()
  nativeFallback: "0xc4048598", // nativeFallback()
  tokenFallback: "0xbd23eb39", // tokenFallback()
  minLiquidityIncrease: "0x5a8efec5", // minLiquidityIncrease()
  minCurrency1BurnAmount: "0xa07d2037", // minCurrency1BurnAmount()
  recipient: "0x66d003ac", // recipient()
  maxCurrency0PerBlock: "0x49003643", // maxCurrency0PerBlock()
  maxCurrency1PerBlock: "0x2aa40fb7", // maxCurrency1PerBlock()
  isAllowlisted: "0x05a3b809", // isAllowlisted(address)
};

export function formatUnits(value, decimals) {
  if (decimals === 0) return value.toString();
  const scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${value / scale}.${fraction}` : `${value / scale}`;
}

export const sameAddress = (a, b) => a.toLowerCase() === b.toLowerCase();

// Two split lists are the same configuration when they hold the same entries in
// any order; the FeeSplitter rejects duplicate recipients, so counts line up.
export function sameSplits(left, right) {
  return (
    left.length === right.length &&
    left.every((expected) =>
      right.some(
        (entry) =>
          sameAddress(entry.recipient, expected.recipient) &&
          entry.nativeBps === expected.nativeBps &&
          entry.tokenBps === expected.tokenBps &&
          entry.useCallback === expected.useCallback,
      ),
    )
  );
}

function rpcUrl(value) {
  let parsed;
  try {
    parsed = new URL(value || DEFAULT_RPC_URL);
  } catch {
    throw new Error("ROBINHOOD_RPC_URL is not a valid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("ROBINHOOD_RPC_URL must use http or https");
  }
  return parsed.toString();
}

function rpcClient(url, fetchImpl) {
  let id = 0;
  return async function rpc(method, params) {
    id += 1;
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not reach the Robinhood Chain RPC for ${method}: ${reason}`);
    }
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Robinhood Chain RPC returned HTTP ${response.status} for ${method}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error(`Robinhood Chain RPC returned a non-JSON response for ${method}`);
    }
    if (parsed.error) {
      throw new Error(`${method} failed: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
    }
    return parsed.result;
  };
}

function hexQuantity(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`Robinhood Chain RPC returned a malformed ${label}`);
  }
  return BigInt(value);
}

function abiWords(hex) {
  if (typeof hex !== "string" || !/^0x([0-9a-fA-F]{64})+$/.test(hex)) {
    throw new Error("empty or malformed return data");
  }
  const words = [];
  for (let index = 2; index < hex.length; index += 64) {
    words.push(hex.slice(index, index + 64));
  }
  return words;
}

const wordToUint = (word) => BigInt(`0x${word}`);

function wordToAddress(word) {
  if (!/^0{24}/.test(word)) throw new Error("malformed address in return data");
  return `0x${word.slice(24)}`;
}

const decodeUint = (hex) => wordToUint(abiWords(hex)[0]).toString();
const decodeAddress = (hex) => wordToAddress(abiWords(hex)[0]);
const decodeBool = (hex) => wordToUint(abiWords(hex)[0]) !== 0n;

// getSplits() returns a dynamic array of static (address, uint16, uint16, bool) tuples.
function decodeSplits(hex) {
  const words = abiWords(hex);
  const offset = wordToUint(words[0]);
  if (offset % 32n !== 0n || offset / 32n >= BigInt(words.length)) {
    throw new Error("malformed getSplits() return data");
  }
  const start = Number(offset / 32n);
  const length = wordToUint(words[start]);
  if (BigInt(words.length) < BigInt(start + 1) + length * 4n) {
    throw new Error("truncated getSplits() return data");
  }
  const splits = [];
  for (let index = 0; index < Number(length); index += 1) {
    const base = start + 1 + index * 4;
    splits.push({
      recipient: wordToAddress(words[base]),
      nativeBps: Number(wordToUint(words[base + 1])),
      tokenBps: Number(wordToUint(words[base + 2])),
      useCallback: wordToUint(words[base + 3]) !== 0n,
    });
  }
  return splits;
}

const NO_CODE = "no bytecode at this address";

// Reads the VestingClaimRecipient's _USE_ARB_SYS immutable from its runtime bytecode:
// true or false, or null when the pattern is not found exactly once.
function arbSysFlag(code) {
  const matches = [...String(code ?? "").toLowerCase().matchAll(ARB_SYS_FLAG)];
  return matches.length === 1 ? matches[0][1] === "01" : null;
}

// Average block time over BLOCK_TIME_WINDOW blocks ending at the pinned block, from eth_getBlockByNumber timestamps.
async function measureBlockTime(rpc, blockNumber) {
  const blocks = blockNumber > BLOCK_TIME_WINDOW ? BLOCK_TIME_WINDOW : blockNumber - 1n;
  if (blocks <= 0n) throw new Error("the chain has too few blocks");
  const timestampOf = async (number) => {
    const block = await rpc("eth_getBlockByNumber", [`0x${number.toString(16)}`, false]);
    return hexQuantity(block?.timestamp, `timestamp for block ${number}`);
  };
  const fromBlock = blockNumber - blocks;
  const seconds = (await timestampOf(blockNumber)) - (await timestampOf(fromBlock));
  if (seconds <= 0n) throw new Error(`block ${blockNumber} is not later than block ${fromBlock}`);
  return { fromBlock, toBlock: blockNumber, blocks, seconds };
}

const formatRounded = (value, decimals, places) => formatUnits(value / 10n ** BigInt(decimals - places), places);

// Release capacity the vesting caps build up per position per day: cap per block times the blocks in a day at
// the measured block time, rounded down. It is a rate, not a daily ceiling: capacity not used while nobody claims
// carries over (VestingClaimRecipient.sol:156-169 at 0b5ee05). The display fields assume native ETH on the native
// side and 18 decimals on the token side.
function dailyReleaseCaps(maxCurrency0PerBlock, maxCurrency1PerBlock, { blocks, seconds }) {
  const perDay = (perBlock) => (BigInt(perBlock) * SECONDS_PER_DAY * blocks) / seconds;
  const currency0 = perDay(maxCurrency0PerBlock);
  const currency1 = perDay(maxCurrency1PerBlock);
  return {
    blocksPerDay: ((SECONDS_PER_DAY * blocks) / seconds).toString(),
    maxCurrency0: currency0.toString(),
    maxCurrency0Eth: formatRounded(currency0, 18, 2),
    maxCurrency1: currency1.toString(),
    maxCurrency1TokensAt18Decimals: formatRounded(currency1, 18, 2),
    unit: "base units of release capacity per position per day; unused capacity carries over",
  };
}

const addressArgument = (address) => address.toLowerCase().slice(2).padStart(64, "0");

export async function verify(env, fetchImpl) {
  const rpc = rpcClient(rpcUrl(env.ROBINHOOD_RPC_URL), fetchImpl);

  const chainId = Number(hexQuantity(await rpc("eth_chainId", []), "chain id"));
  if (chainId !== ROBINHOOD_CHAIN_ID) {
    throw new Error(prose`The RPC reports chainId ${chainId}, expected Robinhood Chain ${ROBINHOOD_CHAIN_ID}.
      Refusing to verify against another chain.`);
  }
  const blockHex = await rpc("eth_blockNumber", []);
  const blockNumber = hexQuantity(blockHex, "block number");

  const findings = [];
  const contracts = [];
  let vestingCode = null;
  for (const entry of LAUNCHPAD_CONTRACTS) {
    const code = await rpc("eth_getCode", [entry.address, blockHex]);
    if (typeof code !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(code)) {
      throw new Error(`Robinhood Chain RPC returned malformed bytecode for ${entry.address}`);
    }
    const codeBytes = (code.length - 2) / 2;
    if (sameAddress(entry.address, VESTING)) vestingCode = code;
    contracts.push({ ...entry, status: codeBytes > 0 ? "present" : "missing", codeBytes });
    if (codeBytes === 0) {
      const name = entry.version ? `${entry.name} ${entry.version}` : entry.name;
      findings.push(`${name} has no bytecode at ${entry.address}. Do not plan around it.`);
    }
  }
  const present = (address) =>
    contracts.some((entry) => sameAddress(entry.address, address) && entry.status === "present");

  // Reads one value at the pinned block. A missing contract is skipped; a failed read becomes a finding.
  async function read(name, to, data, decode) {
    if (to !== ARB_SYS && !present(to)) return { value: null, error: NO_CODE };
    try {
      return { value: decode(await rpc("eth_call", [{ to, data }, blockHex])) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      findings.push(`Could not read ${name}: ${reason}.`);
      return { value: null, error: reason };
    }
  }
  const value = async (...args) => (await read(...args)).value;

  const splitters = [];
  for (const deployed of DEPLOYED_SPLITTERS) {
    const { address } = deployed;
    const onChain = await read(`getSplits() on ${address}`, address, SELECTORS.getSplits, decodeSplits);
    const matchesPublished = onChain.value ? sameSplits(deployed.splits, onChain.value) : null;
    if (matchesPublished === false) {
      findings.push(`The FeeSplitter at ${address} does not report its published splits. Use onChainSplits.`);
    }
    splitters.push({
      address,
      version: deployed.version,
      label: deployed.label,
      publishedSplits: deployed.splits,
      onChainSplits: onChain.value,
      matchesPublished,
      ...(onChain.error ? { error: onChain.error } : {}),
    });
  }

  const vaults = [];
  const compounding = [];
  for (const { release, vault, compounding: address } of RELEASES) {
    const allowlistCall = `${SELECTORS.isAllowlisted}${addressArgument(vault)}`;
    vaults.push({
      release,
      address: vault,
      nativeFallback: await value(`${release} vault nativeFallback`, vault, SELECTORS.nativeFallback, decodeAddress),
      tokenFallback: await value(`${release} vault tokenFallback`, vault, SELECTORS.tokenFallback, decodeAddress),
      vestingAllowlisted: await value(`isAllowlisted(${release} vault)`, VESTING, allowlistCall, decodeBool),
      usedForVesting: sameAddress(vault, VESTING_VAULT),
    });
    const minLiquidityCall = SELECTORS.minLiquidityIncrease;
    const minLiquidityIncrease = await value(`${release} minLiquidityIncrease`, address, minLiquidityCall, decodeUint);
    compounding.push({ release, address, minLiquidityIncrease });
  }
  const burn = await value("minCurrency1BurnAmount", BUYBACK, SELECTORS.minCurrency1BurnAmount, decodeUint);
  const vestingRecipient = await value("vesting recipient", VESTING, SELECTORS.recipient, decodeAddress);
  const maxCurrency0PerBlock =
    await value("maxCurrency0PerBlock", VESTING, SELECTORS.maxCurrency0PerBlock, decodeUint);
  const maxCurrency1PerBlock =
    await value("maxCurrency1PerBlock", VESTING, SELECTORS.maxCurrency1PerBlock, decodeUint);
  const allowlistsVestingVault = vaults.find((entry) => entry.usedForVesting).vestingAllowlisted;

  // The vesting caps count ArbSys blocks (BlockNumberish). They convert to days only when the contract uses ArbSys
  // and ArbSys counts the same blocks as eth_blockNumber.
  const usesArbSys = arbSysFlag(vestingCode);
  const arbBlockNumber = await value("ArbSys arbBlockNumber", ARB_SYS, ARB_BLOCK_NUMBER, decodeUint);
  const matchesBlockNumber = arbBlockNumber === null ? null : arbBlockNumber === blockNumber.toString();
  let blockTime = null;
  try {
    blockTime = await measureBlockTime(rpc, blockNumber);
  } catch (error) {
    findings.push(`Could not measure the block time: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (usesArbSys === false) {
    findings.push("The VestingClaimRecipient counts block.number, not ArbSys blocks. releasePerDay is not computed.");
  } else if (usesArbSys === null && present(VESTING)) {
    findings.push(prose`Could not read from its bytecode which block count the VestingClaimRecipient uses.
      releasePerDay is not computed.`);
  }
  if (matchesBlockNumber === false) {
    findings.push(prose`ArbSys arbBlockNumber is ${arbBlockNumber} at block ${blockNumber}, so the vesting caps do
      not follow eth_blockNumber. releasePerDay is not computed.`);
  }
  const clockConfirmed = usesArbSys === true && matchesBlockNumber === true && blockTime !== null;
  const releasePerDay =
    clockConfirmed && maxCurrency0PerBlock !== null && maxCurrency1PerBlock !== null
      ? dailyReleaseCaps(maxCurrency0PerBlock, maxCurrency1PerBlock, blockTime)
      : null;

  if (burn !== null && burn !== BUYBACK_BURN_PER_CLAIM.toString()) {
    findings.push(prose`The BuybackAndBurnClaimRecipient burns ${burn} base units per claim, not the
      ${BUYBACK_BURN_PER_CLAIM} the plan assumes. Use the on-chain value.`);
  }
  if (vestingRecipient !== null && !sameAddress(vestingRecipient, BUYBACK)) {
    findings.push(prose`The VestingClaimRecipient releases to ${vestingRecipient}, not to the
      BuybackAndBurnClaimRecipient at ${BUYBACK}.`);
  }
  if (allowlistsVestingVault === false) {
    findings.push(prose`The VestingClaimRecipient does not allowlist the vault at ${VESTING_VAULT}, so the vesting
      route is blocked.`);
  }

  return {
    chainId,
    blockNumber: blockNumber.toString(),
    rpc: env.ROBINHOOD_RPC_URL ? "ROBINHOOD_RPC_URL" : "default public RPC",
    allPresent: contracts.every((entry) => entry.status === "present"),
    contracts,
    splitters,
    recipients: {
      vaults,
      compounding,
      buyback: { address: BUYBACK, minCurrency1BurnAmount: burn, unit: "token base units" },
      vesting: {
        address: VESTING,
        recipient: vestingRecipient,
        releasesToBuyback: vestingRecipient === null ? null : sameAddress(vestingRecipient, BUYBACK),
        maxCurrency0PerBlock,
        maxCurrency1PerBlock,
        unit: "base units per block, per position",
        blockClock: { usesArbSys, arbBlockNumber, matchesBlockNumber },
        blockTime: blockTime && {
          fromBlock: blockTime.fromBlock.toString(),
          toBlock: blockTime.toBlock.toString(),
          seconds: blockTime.seconds.toString(),
          secondsPerBlock: formatUnits((blockTime.seconds * 10n ** 6n) / blockTime.blocks, 6),
        },
        releasePerDay,
        vestingVault: VESTING_VAULT,
        allowlistsVestingVault,
      },
    },
    findings,
    notice: "Read-only checks. Nothing was signed, deployed or submitted.",
  };
}
