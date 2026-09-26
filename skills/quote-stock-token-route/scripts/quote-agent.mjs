#!/usr/bin/env node

// Quote specialist tooling: reads the desk's executable Uniswap quote for a
// Stock Token buy on Robinhood Chain, through the public PerkOS desk quote
// route, and prints it with the route, the price impact and the protocols the
// quote considered. It only reads. It never builds calldata, signs, deploys or
// submits anything. Field meanings: references/quote-fields.md.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_QUOTE_URL = "https://api.perkos.xyz/desks/stocks-robinhood/quote";
const ROBINHOOD_CHAIN_ID = 4663;
// USDG on Robinhood Chain 4663: symbol() is "USDG" and decimals() is 6 on chain.
const USDG_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const USDG_SYMBOL = "USDG";
const USDG_DECIMALS = 6;
const PRICE_DECIMALS = 6;
const REQUEST_TIMEOUT_MS = 30_000;
const NOTICE =
  "Analysis only. No calldata was built and nothing was signed, deployed or submitted.";

// Values of the Uniswap Trading API `protocols` field, grouped by family.
const PROTOCOL_FAMILIES = {
  V2: ["V2"],
  V3: ["V3"],
  V4: ["V4"],
  UNISWAPX: ["UNISWAPX", "UNISWAPX_V2", "UNISWAPX_V3", "UNISWAPX_LATEST"],
};

// Routing values the Uniswap Trading API settles through a UniswapX order.
const UNISWAPX_ROUTINGS = new Set([
  "DUTCH_V2",
  "DUTCH_V3",
  "PRIORITY",
  "LIMIT_ORDER",
]);
const UNISWAPX_ORDER =
  "UniswapX signed order. A filler settles it onchain, gasless for the swapper.";

// Values of the Uniswap Trading API `routing` field and how each settles.
const ROUTING_TYPES = {
  CLASSIC:
    "Uniswap AMM pools (v2, v3, v4). Settles as a transaction the swapper sends.",
  DUTCH_V2: UNISWAPX_ORDER,
  DUTCH_V3: UNISWAPX_ORDER,
  PRIORITY: UNISWAPX_ORDER,
  LIMIT_ORDER: UNISWAPX_ORDER,
  WRAP: "Wraps the native token. Settles as a transaction.",
  UNWRAP: "Unwraps to the native token. Settles as a transaction.",
  BRIDGE: "Cross-chain bridge. Settles as a transaction.",
  CHAINED: "Multi-step plan executed as ordered steps.",
  DUTCH_LIMIT: "Listed by the Uniswap API. How it settles is not documented.",
};

// Pool types in a Uniswap Trading API route.
const POOL_PROTOCOLS = { "v2-pool": "V2", "v3-pool": "V3", "v4-pool": "V4" };
const V2_FEE_PCT = "0.3";

function usage() {
  return [
    "Usage:",
    "  quote-agent.mjs quote <ticker> <atomic-usdg>",
    "",
    "<atomic-usdg> is USDG in atomic units (6 decimals): 100 USDG is 100000000,",
    "the most the desk quotes by default.",
    `The quote is read from ${DEFAULT_QUOTE_URL}.`,
    "Set PERKOS_DESK_QUOTE_URL to the full URL of another desk quote route.",
    "Read only: it never builds calldata, signs, deploys or submits anything.",
  ].join("\n");
}

function quoteUrl(value) {
  let parsed;
  try {
    parsed = new URL(value || DEFAULT_QUOTE_URL);
  } catch {
    throw new Error("PERKOS_DESK_QUOTE_URL is not a valid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("PERKOS_DESK_QUOTE_URL must use http or https");
  }
  return parsed;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

// The same ticker shape the desk accepts, upper-cased.
function normalizeTicker(value) {
  const ticker = String(value ?? "").trim().toUpperCase();
  return /^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker) ? ticker : undefined;
}

function decimalsOf(value) {
  const text = String(value ?? "");
  return /^\d{1,2}$/.test(text) ? Number(text) : undefined;
}

function formatUnits(value, decimals) {
  const base = 10n ** BigInt(decimals);
  const fraction = (value % base)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  const whole = (value / base).toString();
  return fraction ? `${whole}.${fraction}` : whole;
}

// numerator / denominator as a decimal string, rounded half up.
function ratio(numerator, denominator, decimals) {
  const scaled =
    (numerator * 10n ** BigInt(decimals) * 2n + denominator) /
    (2n * denominator);
  return formatUnits(scaled, decimals);
}

// The answer as JSON, or json: false when it is not JSON (an empty answer reads as {}).
async function readAnswer(response, where) {
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw new Error(
      `Could not read the answer from the desk quote route at ${where}: ${messageOf(error)}`,
    );
  }
  if (!text) return { json: true, body: {} };
  try {
    return { json: true, body: JSON.parse(text) };
  } catch {
    return { json: false, body: null };
  }
}

// The desk answers { error, message }; a PerkOS error envelope nests them as { error: { code, message } }.
function reasonOf(body) {
  if (!isRecord(body)) return "no detail";
  const detail = isRecord(body.error)
    ? [body.error.code, body.error.message]
    : [body.error, body.message];
  return (
    detail.filter((part) => typeof part === "string" && part).join(": ") ||
    "no detail"
  );
}

function noRoute(where, detail) {
  return (
    `There is no desk quote route at ${where} (${detail}). ` +
    "The route may not be deployed on PerkOS yet, or PERKOS_DESK_QUOTE_URL " +
    "is wrong. There is no executable price. Do not retry in a loop."
  );
}

function quoteFailure(status, body, ticker, where, retryAfter) {
  const reason = reasonOf(body);
  if (status === 429) {
    const wait = /^\d+$/.test(retryAfter ?? "")
      ? `${retryAfter} seconds`
      : "the time the server asks for";
    return (
      `PerkOS or the desk is limiting new quotes (429 ${reason}). ` +
      `Wait ${wait} before asking again, and do not retry in a loop. ` +
      "There is no executable price right now."
    );
  }
  if (status === 404 && body?.error === "not_found" && !body?.message) {
    return noRoute(where, "404 not_found");
  }
  if (
    (status === 400 && body?.error === "invalid_module") ||
    (status === 404 && body?.error === "unknown_module")
  ) {
    return (
      `PerkOS does not know the desk named in the quote URL (${status} ${reason}). ` +
      "Check PERKOS_DESK_QUOTE_URL. There is no executable price."
    );
  }
  if (status === 400) {
    return `The desk rejected the quote request (400 ${reason}).`;
  }
  if (status === 404) {
    return (
      `No executable quote for ${ticker} (404 ${reason}). ` +
      "Do not substitute another asset."
    );
  }
  if (
    status === 502 &&
    body?.error === "uniswap_quote_failed" &&
    /\bstatus 404\b/.test(String(body?.message ?? ""))
  ) {
    return (
      `Uniswap returned no quote for ${ticker} (502 ${reason}). ` +
      "The desk does not pass on the Uniswap error code, so the cause " +
      "is unknown. There is no executable price. Do not substitute another asset."
    );
  }
  if (status === 503 && body?.error === "desk_unavailable") {
    return (
      `The desk is not answering through PerkOS (503 ${reason}). ` +
      "There is no executable price right now. Ask again later, and do not " +
      "retry in a loop."
    );
  }
  if (status === 502 || status === 503) {
    return (
      `The quote is unavailable upstream (${status} ${reason}). ` +
      "There is no executable price right now."
    );
  }
  return (
    `The desk quote request failed (${status} ${reason}). ` +
    "There is no executable price."
  );
}

function readQuote(body, { ticker, amountIn }) {
  if (!isRecord(body)) {
    throw new Error("Refusing the quote: the desk returned no quote");
  }
  if (Number(body.chainId) !== ROBINHOOD_CHAIN_ID) {
    throw new Error(
      `Refusing the quote: it is for chain ${body.chainId ?? "unknown"}, ` +
        `not Robinhood Chain ${ROBINHOOD_CHAIN_ID}`,
    );
  }
  if (String(body.ticker ?? "").toUpperCase() !== ticker) {
    throw new Error(
      `Refusing the quote: it prices ${body.ticker ?? "an unnamed asset"}, ` +
        `not ${ticker}`,
    );
  }
  if (String(body.amountIn ?? "") !== amountIn) {
    throw new Error(
      `Refusing the quote: it prices ${body.amountIn ?? "an unknown amount"} ` +
        `atomic USDG, not the requested ${amountIn}`,
    );
  }
  const tokenIn = isRecord(body.tokenIn) ? body.tokenIn : {};
  if (
    !isAddress(tokenIn.address) ||
    tokenIn.address.toLowerCase() !== USDG_ADDRESS.toLowerCase() ||
    tokenIn.symbol !== USDG_SYMBOL ||
    decimalsOf(tokenIn.decimals) !== USDG_DECIMALS
  ) {
    throw new Error(
      `Refusing the quote: the input token is not USDG (${USDG_ADDRESS}) ` +
        "with 6 decimals",
    );
  }
  const tokenOut = isRecord(body.tokenOut) ? body.tokenOut : {};
  const outDecimals = decimalsOf(tokenOut.decimals);
  if (outDecimals === undefined || !isAddress(tokenOut.address)) {
    throw new Error(
      "Refusing the quote: the output token address or decimals are missing",
    );
  }
  const amountOut = String(body.amountOut ?? "");
  if (!/^[1-9]\d*$/.test(amountOut)) {
    throw new Error("Refusing the quote: it has no executable output amount");
  }
  if (!stringOrNull(body.requestId)) {
    throw new Error(
      "Refusing the quote: it has no Uniswap request id to record",
    );
  }
  return { tokenIn, tokenOut, outDecimals, amountOut: BigInt(amountOut) };
}

// USDG paid per whole token received. The desk quote carries no shares-per-token multiplier.
function usdgPerToken({ amountIn, amountOut, outDecimals }) {
  return ratio(
    amountIn * 10n ** BigInt(outDecimals),
    amountOut * 10n ** BigInt(USDG_DECIMALS),
    PRICE_DECIMALS,
  );
}

function feePct(pool) {
  if (pool.type === "v2-pool") return V2_FEE_PCT;
  const fee = String(pool.fee ?? "");
  if (!/^\d{1,7}$/.test(fee) || Number(fee) > 1_000_000) return null;
  return formatUnits(BigInt(fee), 4);
}

function summarizeHop(hop) {
  const pool = isRecord(hop) ? hop : {};
  const protocol = POOL_PROTOCOLS[pool.type] ?? null;
  const summary = {
    protocol,
    pool: stringOrNull(pool.address),
    tokenIn: stringOrNull(pool.tokenIn?.symbol),
    tokenOut: stringOrNull(pool.tokenOut?.symbol),
    feePct: feePct(pool),
  };
  if (pool.tickSpacing !== undefined) {
    summary.tickSpacing = String(pool.tickSpacing);
  }
  if (protocol === "V4") summary.hooks = stringOrNull(pool.hooks);
  return summary;
}

function atomicOf(value) {
  const text = String(value ?? "");
  return /^\d+$/.test(text) ? BigInt(text) : undefined;
}

function summarizeRoute(route) {
  if (!Array.isArray(route)) return { paths: [], protocolsUsed: [] };
  const paths = route.map((path) => (Array.isArray(path) ? path : [path]));
  const inputs = paths.map((hops) => atomicOf(hops[0]?.amountIn));
  const total = inputs.every((value) => value !== undefined)
    ? inputs.reduce((sum, value) => sum + value, 0n)
    : 0n;
  const summaries = paths.map((hops, index) => ({
    sharePct:
      total > 0n ? Number((inputs[index] * 10_000n) / total) / 100 : null,
    hops: hops.map(summarizeHop),
  }));
  const protocolsUsed = [
    ...new Set(
      summaries.flatMap((path) =>
        path.hops.map((hop) => hop.protocol).filter(Boolean),
      ),
    ),
  ];
  return { paths: summaries, protocolsUsed };
}

function protocolCoverage(protocols) {
  const considered = Array.isArray(protocols)
    ? protocols.filter((value) => typeof value === "string" && value)
    : [];
  if (considered.length === 0) return { considered: null, excluded: null };
  const requested = considered.map((value) => value.toUpperCase());
  const excluded = Object.entries(PROTOCOL_FAMILIES)
    .filter(([, members]) => !members.some((name) => requested.includes(name)))
    .map(([family]) => family);
  return { considered, excluded };
}

function summarizeQuote({ body, quote, amountIn, ticker }) {
  const gaps = [];

  const priceImpactPct =
    typeof body.priceImpactPct === "number" &&
    Number.isFinite(body.priceImpactPct)
      ? body.priceImpactPct
      : null;
  if (priceImpactPct === null) {
    gaps.push("The desk did not report the price impact at this size.");
  }

  const gasFeeUsd = stringOrNull(body.gasFeeUsd);
  if (gasFeeUsd === null) {
    gaps.push("The desk did not report a gas estimate.");
  }

  const routingType = stringOrNull(body.routing);
  const documented = Object.hasOwn(ROUTING_TYPES, routingType ?? "");
  if (!documented) {
    gaps.push(
      routingType
        ? `Routing "${routingType}" is not a documented Uniswap API routing value.`
        : "The desk did not report the routing type.",
    );
  }

  const route = summarizeRoute(body.route);
  if (route.paths.length === 0) {
    gaps.push(
      UNISWAPX_ROUTINGS.has(routingType)
        ? "UniswapX quotes carry no pool-by-pool route."
        : "The desk returned no route detail.",
    );
  }

  const protocols = protocolCoverage(body.protocols);
  if (protocols.considered === null) {
    gaps.push(
      "The desk did not report which protocols the quote considered, " +
        "so the excluded protocols are unknown.",
    );
  }

  const quotedAt = stringOrNull(body.quotedAt);
  if (quotedAt === null) gaps.push("The quote has no timestamp.");

  const attribution = isRecord(body.attribution)
    ? {
        decisionOrigin: body.attribution.decisionOrigin ?? null,
        status: body.attribution.status ?? null,
      }
    : null;
  if (attribution === null) {
    gaps.push("The desk did not report the X-Agent-Info attribution.");
  } else if (attribution.status === "malformed") {
    gaps.push("Uniswap dropped the X-Agent-Info header as malformed.");
  }

  return {
    chainId: ROBINHOOD_CHAIN_ID,
    ticker,
    requestId: body.requestId,
    quotedAt,
    pay: {
      amount: formatUnits(BigInt(amountIn), USDG_DECIMALS),
      symbol: USDG_SYMBOL,
      atomic: amountIn,
      token: stringOrNull(quote.tokenIn.address),
    },
    receive: {
      amount: formatUnits(quote.amountOut, quote.outDecimals),
      symbol: stringOrNull(quote.tokenOut.symbol),
      atomic: quote.amountOut.toString(),
      token: quote.tokenOut.address,
      decimals: quote.outDecimals,
    },
    executablePrice: {
      usdgPerToken: usdgPerToken({
        amountIn: BigInt(amountIn),
        amountOut: quote.amountOut,
        outDecimals: quote.outDecimals,
      }),
    },
    priceImpactPct,
    gasFeeUsd,
    routing: {
      type: routingType,
      settles: documented ? ROUTING_TYPES[routingType] : null,
      documented,
    },
    route,
    protocols,
    attribution,
    gaps,
    notice: NOTICE,
  };
}

export async function runCli({
  argv,
  env = process.env,
  fetchImpl = fetch,
  write = (value) => console.log(value),
}) {
  const route = quoteUrl(env.PERKOS_DESK_QUOTE_URL);
  // Where the quote was asked, without its query, for messages.
  const where = `${route.origin}${route.pathname}`;
  const [command = "help", ...args] = argv;

  if (command === "quote") {
    if (args.some((value) => value.startsWith("--"))) {
      throw new Error(
        "quote-agent.mjs only reads quotes. It has no flags and no execution mode.",
      );
    }
    const ticker = normalizeTicker(args[0]);
    const amountIn = args[1];
    if (!ticker || !/^[1-9]\d*$/.test(amountIn ?? "") || args.length > 2) {
      throw new Error(usage());
    }

    const url = new URL(route);
    url.searchParams.set("ticker", ticker);
    url.searchParams.set("amountIn", amountIn);
    let response;
    try {
      response = await fetchImpl(url.toString(), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(
        `Could not reach the desk quote route at ${where}: ${messageOf(error)}`,
      );
    }
    const answer = await readAnswer(response, where);
    if (!answer.json) {
      if (response.status === 404) {
        throw new Error(noRoute(where, "404, and the answer is not JSON"));
      }
      throw new Error(
        `The desk quote route returned a non-JSON response (${response.status}). ` +
          "There is no executable price.",
      );
    }
    const { body } = answer;
    if (!response.ok) {
      throw new Error(
        quoteFailure(
          response.status,
          body,
          ticker,
          where,
          response.headers.get("retry-after"),
        ),
      );
    }
    const quote = readQuote(body, { ticker, amountIn });
    write(
      JSON.stringify(summarizeQuote({ body, quote, amountIn, ticker }), null, 2),
    );
    return;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    write(usage());
    return;
  }

  throw new Error(usage());
}

// Resolves symlinks on both sides, so a linked path to this file still runs it.
function launchedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (launchedDirectly()) {
  runCli({ argv: process.argv.slice(2) }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
