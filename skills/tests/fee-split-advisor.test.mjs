import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DEPLOYED_SPLITTERS,
  LAUNCHPAD_CONTRACTS,
  runCli,
} from "../design-fee-split/scripts/fee-split-advisor.mjs";

const SCRIPT = fileURLToPath(
  new URL("../design-fee-split/scripts/fee-split-advisor.mjs", import.meta.url),
);

const VAULT_V33 = "0x26d2F7AcB07707034406a0dC458351Bb63C02553";
const VAULT_V32 = "0xd35E9CA72F64C7F93BE30fad67524323396B36D7";
const COMPOUNDING_V33 = "0xf585b5D728A8fdE743027307BF5F3556E3B9C58D";
const COMPOUNDING_V32 = "0xf9526Dd3361fe0ba6b7a99533ed471D3E808E99a";
const BUYBACK = "0xa1ba4CC12654D2b188e3ba77dc86c75cA47f1A4e";
const VESTING = "0xeF451B293ED8C61d20f7d13ef336a496F0cc2c26";
const SPLITTER_V33_CREATOR = "0x9411fa7F956f64aa7981AA27cB3bC6eC0415449C";
const SPLITTER_V33_NO_CREATOR = "0x882Ae5e2095435A62Fd1BBDEfcb637f5CeAFc0ee";
const SPLITTER_V32_CREATOR = "0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf";
const SPLITTER_V32_NO_CREATOR = "0x222D6d4f1ce59b0d48D5505114eC8Addc90A4359";
const TOKEN_JAR = "0x2aC03e14Cfe755426DaAEe0a4994184Ce81482F8";
const BURN = "0x000000000000000000000000000000000000dEaD";
const BURN_PER_CLAIM = 500_000n * 10n ** 18n;
const ARB_SYS = "0x0000000000000000000000000000000000000064";
const BLOCK_NUMBER = 0x4568a14;
// The runtime sequence BlockNumberish compiles to: PUSH32 <_USE_ARB_SYS> ISZERO PUSH2 JUMPI PUSH4 arbBlockNumber().
const vestingRuntime = (flag = "01") => `0x7f${"0".repeat(62)}${flag}15610bff5763a3b1b31d`;

const noNetwork = async () => {
  throw new Error("plan must not touch the network");
};

async function plan(args) {
  const output = [];
  await runCli({ argv: ["plan", ...args], env: {}, fetchImpl: noNetwork, write: (value) => output.push(value) });
  return JSON.parse(output[0]);
}

const refusesPlan = (args, pattern) =>
  assert.rejects(runCli({ argv: ["plan", ...args], env: {}, fetchImpl: noNetwork, write: () => {} }), pattern);

// ABI encoding helpers for the fake Robinhood Chain RPC.
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const addressWord = (address) => address.toLowerCase().slice(2).padStart(64, "0");
const encodeUint = (value) => `0x${word(value)}`;
const encodeAddress = (address) => `0x${addressWord(address)}`;
const encodeSplit = ({ recipient, nativeBps, tokenBps, useCallback }) =>
  addressWord(recipient) + word(nativeBps) + word(tokenBps) + word(useCallback ? 1 : 0);
const encodeSplits = (splits) => `0x${word(32)}${word(splits.length)}${splits.map(encodeSplit).join("")}`;

const reply = (id, body) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, ...body }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function fakeChain({
  chainId = "0x1237",
  missing = [],
  splits = {},
  allowlisted = { [VAULT_V33]: false, [VAULT_V32]: true },
  vestingRecipient = BUYBACK,
  burnAmount = BURN_PER_CLAIM,
  reverts = [],
  chainIdError,
  code = "0x60806040",
  vestingCode = vestingRuntime(),
  msPerBlock = 100n,
  arbBlockNumber = BLOCK_NUMBER,
  nullBlocks = false,
} = {}) {
  const calls = [];
  const splitsFor = (address) =>
    splits[address.toLowerCase()] ?? DEPLOYED_SPLITTERS.find((entry) => entry.address === address).splits;
  const answers = {
    [`${VESTING}:0x66d003ac`]: encodeAddress(vestingRecipient),
    [`${VESTING}:0x49003643`]: encodeUint(125_000_000_000_000n),
    [`${VESTING}:0x2aa40fb7`]: encodeUint(50_000n * 10n ** 18n),
    [`${BUYBACK}:0xa07d2037`]: encodeUint(burnAmount),
    [`${ARB_SYS}:0xa3b1b31d`]: encodeUint(arbBlockNumber),
  };
  for (const vault of [VAULT_V33, VAULT_V32]) {
    answers[`${vault}:0xc4048598`] = encodeAddress(TOKEN_JAR);
    answers[`${vault}:0xbd23eb39`] = encodeAddress(BURN);
    answers[`${VESTING}:0x05a3b809${addressWord(vault)}`] = encodeUint(allowlisted[vault] ? 1 : 0);
  }
  for (const compounding of [COMPOUNDING_V33, COMPOUNDING_V32]) {
    answers[`${compounding}:0x5a8efec5`] = encodeUint(10n ** 20n);
  }
  for (const { address } of DEPLOYED_SPLITTERS) {
    answers[`${address}:0x520db906`] = encodeSplits(splitsFor(address));
  }
  const lowered = Object.fromEntries(Object.entries(answers).map(([key, answer]) => [key.toLowerCase(), answer]));

  async function fetchImpl(url, init) {
    const request = JSON.parse(init.body);
    calls.push({ url, request });
    const { id, method, params } = request;
    if (method === "eth_chainId") {
      if (chainIdError) return reply(id, { error: { code: -32000, message: chainIdError } });
      return reply(id, { result: chainId });
    }
    if (method === "eth_blockNumber") return reply(id, { result: "0x4568a14" });
    if (method === "eth_getBlockByNumber") {
      if (nullBlocks) return reply(id, { result: null });
      const timestamp = 1_700_000_000n + (BigInt(params[0]) * msPerBlock) / 1000n;
      return reply(id, { result: { number: params[0], timestamp: `0x${timestamp.toString(16)}` } });
    }
    if (method === "eth_getCode") {
      const absent = missing.some((entry) => entry.toLowerCase() === params[0].toLowerCase());
      const isVesting = params[0].toLowerCase() === VESTING.toLowerCase();
      return reply(id, { result: absent ? "0x" : isVesting ? vestingCode : code });
    }
    if (method === "eth_call") {
      const key = `${params[0].to}:${params[0].data}`.toLowerCase();
      const answer = reverts.some((entry) => entry.toLowerCase() === key) ? undefined : lowered[key];
      return answer ? reply(id, { result: answer }) : reply(id, { error: { code: 3, message: "execution reverted" } });
    }
    return reply(id, { error: { code: -32601, message: "method not found" } });
  }

  return { calls, fetchImpl };
}

async function verify(options = {}, env = {}) {
  const chain = fakeChain(options);
  const output = [];
  await runCli({ argv: ["verify"], env, fetchImpl: chain.fetchImpl, write: (value) => output.push(value) });
  return { report: JSON.parse(output[0]), calls: chain.calls };
}

const refusesVerify = (argv, fetchImpl, pattern, env = {}) =>
  assert.rejects(runCli({ argv, env, fetchImpl, write: () => {} }), pattern);

test("plans the published creator-fee split for a 55 / 45 auction", async () => {
  const result = await plan([
    "--auction-pct", "55",
    "--shares", "vault=40/0,compounding=60/100",
    "--fees-usd", "10000",
    "--total-supply", "1000000000",
  ]);

  assert.equal(result.chainId, 4663);
  assert.equal(result.auction.auctionShareMps, 5_500_000);
  assert.match(result.auction.auctionShareNote, /tokenSplitToAuction; do not pass that name/);
  assert.equal(result.auction.lpReservePct, "45");
  assert.equal(result.auction.reservedTokenAmountForLP, (450_000_000n * 10n ** 18n).toString());
  assert.equal(result.auction.auctionSupply, (550_000_000n * 10n ** 18n).toString());
  assert.equal(result.auction.decimalsSource, "default 18, not given");
  assert.equal(result.feeSplitter.recipientRelease, "v3.3.0");
  assert.deepEqual(result.feeSplitter.splits, [
    { recipient: VAULT_V33, nativeBps: 4_000, tokenBps: 0, useCallback: true },
    { recipient: COMPOUNDING_V33, nativeBps: 6_000, tokenBps: 10_000, useCallback: true },
  ]);
  assert.equal(result.feeSplitter.nativeBpsTotal, 10_000);
  assert.equal(result.feeSplitter.tokenBpsTotal, 10_000);
  assert.equal(result.feeSplitter.deployed.address, SPLITTER_V33_CREATOR);
  assert.match(result.feeSplitter.deployed.note, /does not allowlist/);
  assert.deepEqual(
    result.feeSplitter.otherDeployedMatches.map((entry) => [entry.address, entry.version]),
    [[SPLITTER_V32_CREATOR, "v3.2.0"]],
  );
  assert.match(result.feeSplitter.otherDeployedMatches[0].note, /VestingClaimRecipient allowlists/);
  assert.equal(result.feeSplitter.needsNewDeployment, false);

  const [vault, compounding] = result.money.perRecipient;
  assert.equal(vault.usd, null);
  assert.equal(vault.usdIfAllFeesNative, 4_000);
  assert.equal(vault.usdIfAllFeesToken, 0);
  assert.equal(compounding.usdIfAllFeesNative, 6_000);
  assert.equal(compounding.usdIfAllFeesToken, 10_000);
  assert.match(result.money.lines[1], /between 0\.00 and 4,000\.00 USD/);
  assert.equal(result.missing.length, 2);
  assert.match(result.missing[0], /^--native-fee-pct/);
  assert.equal(result.missing[1], "--decimals: not given, so 18 was assumed for the token amounts.");
  assert.ok(result.locksIn.some((line) => /holds every position it receives permanently/.test(line)));
  assert.ok(result.shares[0].locksIn.some((line) => /FEEB NFT is transferable/.test(line)));
  assert.ok(result.requires.some((line) => /set positionRecipient to the creator's own address/.test(line)));
  assert.ok(result.requires.some((line) => /does not refuse other positions/.test(line)));
  assert.ok(result.requires.some((line) => /standard, unrestricted token/.test(line)));
  assert.deepEqual(result.blocked, []);
  assert.ok(result.unconfirmed.some((line) => /no official doc describes this flow for a CCA launch/.test(line)));
  assert.match(result.notice, /Nothing was signed, deployed or submitted/);
});

test("prices each share with an explicit native fee assumption", async () => {
  const result = await plan([
    "--auction-pct", "55",
    "--shares", "vault=40/0,compounding=60/100",
    "--fees-usd", "10000",
    "--native-fee-pct", "50",
  ]);

  assert.deepEqual(
    result.money.perRecipient.map((entry) => [entry.share, entry.usd]),
    [["vault", 2_000], ["compounding", 8_000]],
  );
  assert.equal(result.money.nativeFeePct, "50");
  assert.match(result.money.lines[0], /assuming 50% of the fee value accrues on the native side/);
});

test("flags a custom split that needs a new FeeSplitter and prices the buyback burn", async () => {
  const result = await plan([
    "--auction-pct", "30",
    "--shares", "vault=20,buyback=30,compounding=50",
    "--fees-usd", "10000",
    "--total-supply", "1000000000",
  ]);

  assert.equal(result.feeSplitter.deployed, null);
  assert.deepEqual(result.feeSplitter.otherDeployedMatches, []);
  assert.equal(result.feeSplitter.needsNewDeployment, true);
  assert.ok(result.requires.some((line) => /needs a new FeeSplitter deployment, which this desk never/.test(line)));
  assert.deepEqual(
    result.money.perRecipient.map((entry) => [entry.contract, entry.usd, entry.exact]),
    [
      ["UERC20BeneficiaryVault", 2_000, true],
      ["BuybackAndBurnClaimRecipient", 3_000, true],
      ["CompoundingClaimRecipient", 5_000, true],
    ],
  );
  assert.deepEqual(result.feeSplitter.splits[1], {
    recipient: BUYBACK,
    nativeBps: 3_000,
    tokenBps: 3_000,
    useCallback: true,
  });
  assert.deepEqual(result.shares[1].burnPerClaim, {
    baseUnits: BURN_PER_CLAIM.toString(),
    tokens: "500000",
    decimalsSource: "default 18, not given",
    pctOfSupply: "0.05",
  });
  assert.ok(result.requires.some((line) => /standard 18-decimal ERC-20/.test(line)));
  assert.match(result.missing.at(-1), /18 was assumed for the token amounts and the buyback burn/);
  assert.deepEqual(result.blocked, []);
});

test("routes vesting through the vault the vesting contract allowlists", async () => {
  const result = await plan(["--auction-pct", "30", "--shares", "vesting=40/0,compounding=60/100"]);

  const [vesting, compounding] = result.shares;
  assert.equal(vesting.splitterRecipient.address, VAULT_V32);
  assert.deepEqual(vesting.route.map((stop) => stop.address), [VAULT_V32, VESTING, BUYBACK]);
  assert.equal(compounding.splitterRecipient.address, COMPOUNDING_V32);
  assert.equal(result.feeSplitter.recipientRelease, "v3.2.0");
  assert.equal(result.feeSplitter.deployed.address, SPLITTER_V32_CREATOR);
  assert.equal(result.feeSplitter.needsNewDeployment, false);
  assert.ok(!JSON.stringify(result.feeSplitter.splits).includes(VAULT_V33));
  assert.ok(result.requires.some((line) => /allowlistsVestingVault true/.test(line)));
  assert.ok(result.requires.some((line) => /must not take a fee on transfer/.test(line)));
  assert.ok(result.requires.some((line) => /set positionRecipient to the creator's own address/.test(line)));
  assert.equal(vesting.burnPerClaim.pctOfSupply, null);
});

test("pays vault and vesting through two different vaults", async () => {
  const result = await plan(["--auction-pct", "30", "--shares", "vault=20,vesting=20,compounding=60"]);

  assert.deepEqual(
    result.feeSplitter.splits.map((entry) => entry.recipient),
    [VAULT_V33, VAULT_V32, COMPOUNDING_V33],
  );
  assert.equal(result.feeSplitter.needsNewDeployment, true);
  assert.ok(result.requires.some((line) => /two different vaults/.test(line)));
  assert.equal(result.requires.filter((line) => /set positionRecipient/.test(line)).length, 1);
});

test("keeps every position with the creator until it is registered and moved", async () => {
  const override = /overridePositionRecipient at address\(0\) or set it to the creator/;
  const custody = /can remove all of their liquidity.*No contract forces the transfer/;
  const vault = await plan(["--auction-pct", "55", "--shares", "vault=40/0,compounding=60/100"]);
  assert.equal(vault.requires.filter((line) => override.test(line)).length, 1);
  assert.ok(vault.requires.some((line) => /only the full-range fallback always goes to positionRecipient/.test(line)));
  assert.ok(vault.requires.some((line) => custody.test(line)));
  assert.ok(vault.locksIn.some((line) => custody.test(line)));
  assert.ok(vault.unconfirmed.some((line) => /register them in the vault, then transfer them/.test(line)));
  assert.ok(!vault.unconfirmed.some((line) => /not a documented flow/.test(line)));

  const vesting = await plan(["--auction-pct", "55", "--shares", "vesting=40/0,compounding=60/100"]);
  assert.ok(vesting.requires.some((line) => override.test(line)));
  assert.ok(vesting.locksIn.some((line) => custody.test(line)));
  const rate = /release capacity builds up at about 107 ETH and 42\.8 billion tokens per position per day/;
  assert.ok(vesting.shares[0].locksIn.some((line) => rate.test(line)));
  const carryOver = /not a daily ceiling: capacity not used while nobody claims carries over/;
  assert.ok(vesting.shares[0].locksIn.some((line) => carryOver.test(line)));
  assert.ok(!JSON.stringify(vesting).includes("at most about"));

  const compounding = await plan(["--auction-pct", "55", "--shares", "compounding=100"]);
  assert.ok(!compounding.requires.some((line) => override.test(line) || custody.test(line)));
  assert.ok(!compounding.locksIn.some((line) => custody.test(line)));
  assert.ok(compounding.unconfirmed.some((line) => /not a documented flow/.test(line)));

  const toSplitter = /overridePositionRecipient at address\(0\) or set it to the FeeSplitter/;
  assert.equal(compounding.requires.filter((line) => toSplitter.test(line)).length, 1);
  const buyback = await plan(["--auction-pct", "55", "--shares", "buyback=100"]);
  assert.ok(buyback.requires.some((line) => toSplitter.test(line)));
  assert.ok(!vault.requires.some((line) => toSplitter.test(line)));
  assert.ok(!vesting.requires.some((line) => toSplitter.test(line)));
  assert.ok(vault.requires.some((line) => /cannot register it through custody/.test(line)));
});

test("reports the recipient release of the splits it uses", async () => {
  const release = async (shares) =>
    (await plan(["--auction-pct", "55", "--shares", shares])).feeSplitter.recipientRelease;
  assert.equal(await release("vault=40/0,compounding=60/100"), "v3.3.0");
  assert.equal(await release("vesting=100"), "v3.2.0");
  assert.equal(await release("buyback=100"), "v3.2.0");
  assert.equal(await release("vesting=40/0,buyback=60/100"), "v3.2.0");
  assert.equal(await release("vault=20,vesting=20,compounding=60"), null);
  assert.equal(await release("vault=20,buyback=80"), null);
});

test("says plainly what it could not compute", async () => {
  const result = await plan(["--auction-pct", "12.5", "--shares", "UERC20BeneficiaryVault=100"]);

  assert.equal(result.auction.auctionShareMps, 1_250_000);
  assert.equal(result.auction.reservedTokenAmountForLP, null);
  assert.equal(result.money, null);
  assert.equal(result.missing.length, 2);
  assert.match(result.missing[0], /--total-supply/);
  assert.match(result.missing[1], /--fees-usd/);
  assert.equal(result.feeSplitter.needsNewDeployment, true);
});

test("marks buyback and vesting as blocked when the burn cannot work", async () => {
  const sixDecimals = await plan(["--auction-pct", "55", "--shares", "buyback=100", "--decimals", "6"]);
  assert.deepEqual(sixDecimals.blocked.map((entry) => entry.shares), [["buyback"]]);
  assert.match(sixDecimals.blocked[0].reason, /assumes an 18-decimal token.*500000000000000000 tokens per claim/);
  assert.equal(sixDecimals.shares[0].burnPerClaim.decimalsSource, "given");

  const tinySupply = await plan([
    "--auction-pct", "55",
    "--shares", "vesting=40/0,compounding=60/100",
    "--total-supply", "100000",
  ]);
  assert.deepEqual(tinySupply.blocked.map((entry) => entry.shares), [["vesting"]]);
  assert.match(tinySupply.blocked[0].reason, /more than the whole supply/);
  assert.equal(tinySupply.shares[0].burnPerClaim.pctOfSupply, "500");

  const moreDecimals = await plan(["--auction-pct", "55", "--shares", "buyback=100", "--decimals", "24"]);
  const notAsDesigned = /^This does not work as designed\..* 0\.5 tokens per claim, not 500,000\./;
  assert.match(moreDecimals.blocked[0].reason, notAsDesigned);

  const noBurn = await plan(["--auction-pct", "55", "--shares", "compounding=100", "--decimals", "6"]);
  assert.deepEqual(noBurn.blocked, []);
});

test("refuses an auction share or supply outside the contracts' bounds", async () => {
  await refusesPlan(["--shares", "vault=100"], /--auction-pct is required/);
  await refusesPlan(["--auction-pct", "0", "--shares", "vault=100"], /above 0 and below 100/);
  await refusesPlan(["--auction-pct", "100", "--shares", "vault=100"], /above 0 and below 100/);
  await refusesPlan(["--auction-pct", "101", "--shares", "vault=100"], /at most 100/);
  await refusesPlan(["--auction-pct", "1e2", "--shares", "vault=100"], /plain number/);
  await refusesPlan(["--auction-pct", "-5", "--shares", "vault=100"], /plain number/);
  await refusesPlan(["--auction-pct", "12.123456", "--shares", "vault=100"], /at most 5 decimal places/);
  const base = ["--auction-pct", "55", "--shares", "compounding=100"];
  const tooLarge = /5500000000000000000000000000000 base units, above/;
  await refusesPlan([...base, "--total-supply", "10000000000000"], tooLarge);
  await refusesPlan([...base, "--total-supply", `1${"0".repeat(70)}`], /does not fit in a uint256/);
});

test("refuses fee shares the FeeSplitter would reject", async () => {
  const base = ["--auction-pct", "55"];
  await refusesPlan(base, /--shares is required/);
  await refusesPlan([...base, "--shares", "vault40"], /Cannot read the share "vault40"/);
  await refusesPlan([...base, "--shares", "treasury=100"], /Unknown recipient "treasury"/);
  await refusesPlan([...base, "--shares", "vault=50,Vault=50"], /appears twice/);
  await refusesPlan([...base, "--shares", "vault=40,compounding=50"], /native side shares add up to 90%/);
  await refusesPlan([...base, "--shares", "vault=40/50,compounding=60/40"], /token side shares add up to 90%/);
  await refusesPlan([...base, "--shares", "vault=0,compounding=100"], /0% on both sides/);
  await refusesPlan([...base, "--shares", "vault=150"], /at most 100/);
  await refusesPlan([...base, "--shares", "vault=33.333,compounding=66.667"], /at most 2 decimal places/);
  await refusesPlan([...base, "--shares", "vault=40/0/0,compounding=60"], /at most one "\/"/);
});

test("refuses bad money and supply inputs", async () => {
  const base = ["--auction-pct", "55", "--shares", "compounding=100"];
  await refusesPlan([...base, "--fees-usd", "0"], /--fees-usd must be a positive amount/);
  await refusesPlan([...base, "--fees-usd", "abc"], /--fees-usd must be a positive amount/);
  await refusesPlan([...base, "--fees-usd", "1000000000000.01"], /--fees-usd must be a positive amount/);
  await refusesPlan([...base, "--native-fee-pct", "50"], /only applies together with --fees-usd/);
  await refusesPlan([...base, "--fees-usd", "100", "--native-fee-pct", "120"], /at most 100/);
  await refusesPlan([...base, "--total-supply", "0"], /--total-supply must be a whole number/);
  await refusesPlan([...base, "--total-supply", "1.5"], /--total-supply must be a whole number/);
  await refusesPlan([...base, "--decimals", "40"], /--decimals must be a whole number from 0 to 36/);
  await refusesPlan(
    ["--auction-pct", "0.00001", "--shares", "compounding=100", "--total-supply", "1", "--decimals", "0"],
    /auction would receive zero tokens/,
  );
});

test("refuses unknown, repeated and spending options", async () => {
  const base = ["--auction-pct", "55", "--shares", "compounding=100"];
  await refusesPlan([...base, "--foo", "1"], /Unknown option --foo/);
  await refusesPlan([...base, "--auction-pct", "40"], /--auction-pct was given more than once/);
  await refusesPlan([...base, "extra"], /Unexpected argument "extra"/);
  await refusesPlan(["--auction-pct"], /--auction-pct needs a value/);
  await refusesPlan([...base, "--deploy"], /--deploy is not available/);
  await refusesPlan([...base, "--execute=true"], /--execute is not available/);
  await refusesVerify(["verify", "--sign"], noNetwork, /--sign is not available/);
  await refusesVerify(["deploy-splitter"], noNetwork, /Usage:/);
});

test("verifies every launchpad contract and its fixed configuration on chain", async () => {
  const { report, calls } = await verify();

  assert.equal(report.chainId, 4663);
  assert.equal(report.blockNumber, String(0x4568a14));
  assert.equal(report.rpc, "default public RPC");
  assert.equal(report.allPresent, true);
  assert.equal(report.contracts.length, LAUNCHPAD_CONTRACTS.length);
  assert.ok(report.contracts.every((entry) => entry.status === "present"));
  assert.ok(report.contracts.every((entry) => entry.codeBytes === (entry.address === VESTING ? 43 : 4)));
  assert.deepEqual(
    report.splitters.map((entry) => [entry.address, entry.version, entry.matchesPublished]),
    [
      [SPLITTER_V33_CREATOR, "v3.3.0", true],
      [SPLITTER_V33_NO_CREATOR, "v3.3.0", true],
      [SPLITTER_V32_CREATOR, "v3.2.0", true],
      [SPLITTER_V32_NO_CREATOR, "v3.2.0", true],
    ],
  );
  assert.deepEqual(
    report.recipients.vaults.map((entry) => [entry.address, entry.vestingAllowlisted, entry.usedForVesting]),
    [
      [VAULT_V33, false, false],
      [VAULT_V32, true, true],
    ],
  );
  assert.ok(report.recipients.vaults.every((entry) => entry.nativeFallback === TOKEN_JAR.toLowerCase()));
  assert.ok(report.recipients.vaults.every((entry) => entry.tokenFallback === BURN.toLowerCase()));
  assert.deepEqual(
    report.recipients.compounding.map((entry) => entry.minLiquidityIncrease),
    [(10n ** 20n).toString(), (10n ** 20n).toString()],
  );
  assert.equal(report.recipients.buyback.minCurrency1BurnAmount, BURN_PER_CLAIM.toString());
  assert.equal(report.recipients.vesting.releasesToBuyback, true);
  assert.equal(report.recipients.vesting.maxCurrency0PerBlock, "125000000000000");
  assert.equal(report.recipients.vesting.vestingVault, VAULT_V32);
  assert.equal(report.recipients.vesting.allowlistsVestingVault, true);
  assert.deepEqual(report.recipients.vesting.blockClock, {
    usesArbSys: true,
    arbBlockNumber: String(BLOCK_NUMBER),
    matchesBlockNumber: true,
  });
  assert.equal(report.recipients.vesting.blockTime.secondsPerBlock, "0.1");
  assert.equal(report.recipients.vesting.releasePerDay.blocksPerDay, "864000");
  assert.equal(report.recipients.vesting.releasePerDay.maxCurrency0Eth, "108");
  assert.deepEqual(report.findings, []);
  assert.deepEqual(
    calls.filter((call) => call.request.method === "eth_getBlockByNumber").map((call) => call.request.params),
    [["0x4568a14", false], [`0x${(BLOCK_NUMBER - 1_000_000).toString(16)}`, false]],
  );

  assert.ok(calls.every((call) => call.url === "https://rpc.mainnet.chain.robinhood.com/"));
  const pinned = calls.filter((call) => ["eth_getCode", "eth_call"].includes(call.request.method));
  assert.ok(pinned.every((call) => call.request.params[1] === "0x4568a14"));
  assert.ok(calls.every((call) => call.request.method !== "eth_sendRawTransaction"));
});

test("turns the vesting caps into a daily release rate at the measured block time", async () => {
  const { report } = await verify({ msPerBlock: 333n });

  assert.deepEqual(report.recipients.vesting.blockTime, {
    fromBlock: String(BLOCK_NUMBER - 1_000_000),
    toBlock: String(BLOCK_NUMBER),
    seconds: "333000",
    secondsPerBlock: "0.333",
  });
  assert.deepEqual(report.recipients.vesting.releasePerDay, {
    blocksPerDay: "259459",
    maxCurrency0: "32432432432432432432",
    maxCurrency0Eth: "32.43",
    maxCurrency1: "12972972972972972972972972972",
    maxCurrency1TokensAt18Decimals: "12972972972.97",
    unit: "base units of release capacity per position per day; unused capacity carries over",
  });
  assert.deepEqual(report.findings, []);
});

test("does not compute the daily rate unless the vesting clock is confirmed", async () => {
  const blockCount = await verify({ vestingCode: vestingRuntime("00") });
  assert.equal(blockCount.report.recipients.vesting.blockClock.usesArbSys, false);
  assert.equal(blockCount.report.recipients.vesting.releasePerDay, null);
  assert.deepEqual(blockCount.report.findings, [
    "The VestingClaimRecipient counts block.number, not ArbSys blocks. releasePerDay is not computed.",
  ]);

  const unknown = await verify({ vestingCode: "0x60806040" });
  assert.equal(unknown.report.recipients.vesting.blockClock.usesArbSys, null);
  assert.equal(unknown.report.recipients.vesting.releasePerDay, null);
  assert.match(unknown.report.findings[0], /Could not read from its bytecode which block count/);

  const drift = await verify({ arbBlockNumber: BLOCK_NUMBER - 5 });
  assert.equal(drift.report.recipients.vesting.blockClock.matchesBlockNumber, false);
  assert.equal(drift.report.recipients.vesting.releasePerDay, null);
  assert.match(drift.report.findings[0], /arbBlockNumber is 72780303 at block 72780308/);

  const frozen = await verify({ msPerBlock: 0n });
  assert.equal(frozen.report.recipients.vesting.blockTime, null);
  assert.equal(frozen.report.recipients.vesting.releasePerDay, null);
  assert.match(frozen.report.findings[0], /Could not measure the block time: block 72780308 is not later/);
});

test("does not compute the daily rate when a read it needs fails", async () => {
  const noClock = await verify({ reverts: [`${ARB_SYS}:0xa3b1b31d`] });
  assert.deepEqual(noClock.report.recipients.vesting.blockClock, {
    usesArbSys: true,
    arbBlockNumber: null,
    matchesBlockNumber: null,
  });
  assert.equal(noClock.report.recipients.vesting.releasePerDay, null);
  assert.deepEqual(noClock.report.findings, [
    "Could not read ArbSys arbBlockNumber: eth_call failed: execution reverted.",
  ]);

  const noCap = await verify({ reverts: [`${VESTING}:0x49003643`] });
  assert.equal(noCap.report.recipients.vesting.maxCurrency0PerBlock, null);
  assert.equal(noCap.report.recipients.vesting.releasePerDay, null);
  assert.deepEqual(noCap.report.findings, [
    "Could not read maxCurrency0PerBlock: eth_call failed: execution reverted.",
  ]);

  const noVesting = await verify({ missing: [VESTING] });
  const vesting = noVesting.report.recipients.vesting;
  assert.equal(vesting.blockClock.usesArbSys, null);
  assert.equal(vesting.maxCurrency0PerBlock, null);
  assert.equal(vesting.allowlistsVestingVault, null);
  assert.equal(vesting.releasePerDay, null);
  assert.deepEqual(noVesting.report.findings, [
    `VestingClaimRecipient has no bytecode at ${VESTING}. Do not plan around it.`,
  ]);
  const readsVesting = (call) => call.request.method === "eth_call" && call.request.params[0].to === VESTING;
  assert.ok(!noVesting.calls.some(readsVesting));

  const noBlock = await verify({ nullBlocks: true });
  assert.equal(noBlock.report.recipients.vesting.blockTime, null);
  assert.equal(noBlock.report.recipients.vesting.releasePerDay, null);
  assert.deepEqual(noBlock.report.findings, [
    `Could not measure the block time: Robinhood Chain RPC returned a malformed timestamp for block ${BLOCK_NUMBER}.`,
  ]);
});

test("reports the vesting route blocked when its vault is not allowlisted", async () => {
  const { report } = await verify({ allowlisted: { [VAULT_V33]: false, [VAULT_V32]: false } });

  assert.equal(report.recipients.vesting.allowlistsVestingVault, false);
  assert.deepEqual(report.findings, [
    `The VestingClaimRecipient does not allowlist the vault at ${VAULT_V32}, so the vesting route is blocked.`,
  ]);
});

test("reports a missing contract instead of reading it", async () => {
  const { report, calls } = await verify({ missing: [BUYBACK] });

  assert.equal(report.allPresent, false);
  const buyback = report.contracts.find((entry) => entry.address === BUYBACK);
  assert.equal(buyback.status, "missing");
  assert.equal(buyback.codeBytes, 0);
  assert.equal(report.recipients.buyback.minCurrency1BurnAmount, null);
  assert.deepEqual(report.findings, [
    `BuybackAndBurnClaimRecipient v3.2.0 has no bytecode at ${BUYBACK}. Do not plan around it.`,
  ]);
  assert.ok(!calls.some((call) => call.request.method === "eth_call" && call.request.params[0].to === BUYBACK));
});

test("reports splitter, burn and vesting drift from the published configuration", async () => {
  const { report } = await verify({
    splits: {
      [SPLITTER_V32_CREATOR.toLowerCase()]: [
        { recipient: COMPOUNDING_V32, nativeBps: 10_000, tokenBps: 10_000, useCallback: true },
      ],
    },
    vestingRecipient: VAULT_V33,
    burnAmount: 1n,
  });

  assert.deepEqual(report.splitters.map((entry) => entry.matchesPublished), [true, true, false, true]);
  assert.equal(report.recipients.vesting.releasesToBuyback, false);
  const splitterDrift = `The FeeSplitter at ${SPLITTER_V32_CREATOR} does not report its published splits`;
  assert.ok(report.findings.some((line) => line.startsWith(splitterDrift)));
  assert.ok(report.findings.some((line) => /burns 1 base units per claim, not the 5000000000+ the plan/.test(line)));
  assert.ok(report.findings.some((line) => /releases to 0x26d2/.test(line)));
});

test("reports a read that reverts without hiding the rest", async () => {
  const { report } = await verify({ reverts: [`${COMPOUNDING_V33}:0x5a8efec5`] });

  assert.equal(report.allPresent, true);
  assert.equal(report.recipients.compounding[0].minLiquidityIncrease, null);
  assert.equal(report.recipients.compounding[1].minLiquidityIncrease, (10n ** 20n).toString());
  assert.equal(report.recipients.buyback.minCurrency1BurnAmount, BURN_PER_CLAIM.toString());
  assert.deepEqual(report.findings, [
    "Could not read v3.3.0 minLiquidityIncrease: eth_call failed: execution reverted.",
  ]);
});

test("refuses to verify against another chain, a failing RPC or a malformed answer", async () => {
  await assert.rejects(verify({ chainId: "0x2105" }), /chainId 8453, expected Robinhood Chain 4663/);
  await assert.rejects(verify({ chainIdError: "rate limited" }), /eth_chainId failed: rate limited/);
  await assert.rejects(verify({ chainId: "4663" }), /returned a malformed chain id/);
  await assert.rejects(verify({ code: "0xzz" }), /malformed bytecode for 0x000000001F26a0044BaA66024e7b6599c61963F8/);
  const badGateway = async () => new Response("bad gateway", { status: 502 });
  await refusesVerify(["verify"], badGateway, /HTTP 502 for eth_chainId/);
  const html = async () => new Response("<html>", { status: 200 });
  await refusesVerify(["verify"], html, /non-JSON response for eth_chainId/);
  const unreachable = async () => {
    throw new TypeError("fetch failed");
  };
  const unreachableMessage = /Could not reach the Robinhood Chain RPC for eth_chainId: fetch failed/;
  await refusesVerify(["verify"], unreachable, unreachableMessage);
  await refusesVerify(["verify", "extra"], noNetwork, /Unexpected argument "extra"/);
  await refusesVerify(["verify", "--block", "1"], noNetwork, /Unknown option --block/);
});

test("uses ROBINHOOD_RPC_URL without printing it", async () => {
  const privateUrl = "https://robinhood.rpc.example/secret-key";
  const { report, calls } = await verify({}, { ROBINHOOD_RPC_URL: privateUrl });

  assert.equal(report.rpc, "ROBINHOOD_RPC_URL");
  assert.ok(calls.every((call) => call.url === privateUrl));
  assert.ok(!JSON.stringify(report).includes("secret-key"));
  const ftp = { ROBINHOOD_RPC_URL: "ftp://robinhood.rpc.example" };
  await refusesVerify(["verify"], noNetwork, /ROBINHOOD_RPC_URL must use http or https/, ftp);
  const invalid = { ROBINHOOD_RPC_URL: "not a url" };
  await refusesVerify(["verify"], noNetwork, /ROBINHOOD_RPC_URL is not a valid URL/, invalid);
});

test("prints usage for help", async () => {
  const output = [];
  await runCli({ argv: ["help"], env: {}, fetchImpl: noNetwork, write: (value) => output.push(value) });
  assert.match(output[0], /fee-split-advisor\.mjs plan --auction-pct/);
  assert.match(output[0], /never signs, deploys or submits/);
  assert.match(output[0], /missing says so if the supply or a burn share used it/);
});

test("the CLI prints JSON on success and exits 1 with a message on refusal", () => {
  const ok = spawnSync(process.execPath, [SCRIPT, "plan", "--auction-pct", "55", "--shares", "compounding=100"], {
    encoding: "utf8",
  });
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).feeSplitter.deployed.address, SPLITTER_V33_NO_CREATOR);

  const refused = spawnSync(process.execPath, [SCRIPT, "plan", "--auction-pct", "55", "--shares", "vault=90"], {
    encoding: "utf8",
  });
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /native side shares add up to 90%/);
});
