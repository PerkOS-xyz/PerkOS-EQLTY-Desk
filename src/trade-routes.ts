/**
 * The desk's two trading routes, over HTTP.
 *
 *   GET  /quote?ticker=&amountIn=   what Uniswap gives for amountIn atomic USDG
 *   POST /swap                      the unsigned swap for the person's wallet
 *
 * PerkOS-API is the only caller: it proxies what agents and screens need.
 * Input is checked here, strictly, before anything reaches Uniswap: an
 * unknown field, a number sent as text or text sent as a number is refused.
 * Every refusal is an error code and a message, with a status a caller can
 * act on, and a 429 says in retry-after when to ask again.
 */

import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { TradingConfig } from "./config.ts";
import type { EqltyMarket } from "./market.ts";
import { publicErrorMessage } from "./public-error.ts";
import { QuoteError, QuoteService } from "./quote.ts";
import { SwapError, SwapService } from "./swap.ts";
import { TokenDecimalsReader } from "./token-decimals.ts";
import { StockTokens } from "./tokens.ts";
import { UniswapClient } from "./uniswap-client.ts";

const TICKER = /^[A-Za-z][A-Za-z0-9.-]{0,11}$/;
/** A positive whole number with no leading zero, at most 78 digits (a uint256). */
const AMOUNT = /^[1-9]\d{0,77}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_BODY_BYTES = 128 * 1024;

type Status = 400 | 404 | 409 | 429 | 502 | 503;

export interface Trading {
  quotes: Pick<QuoteService, "quote">;
  swaps: Pick<SwapService, "swap">;
}

/** The services behind the routes, sharing one client, one token list and one decimals cache. */
export function createTrading(
  market: Pick<EqltyMarket, "market">,
  config: TradingConfig,
  fetchImpl?: typeof fetch,
): Trading {
  const uniswap = new UniswapClient({
    apiKey: config.uniswapApiKey,
    apiUrl: config.uniswapApiUrl,
    quoteSwapper: config.quoteSwapper,
    fetchImpl,
  });
  const decimals = new TokenDecimalsReader({ rpcUrl: config.robinhoodRpcUrl, fetchImpl });
  const tokens = new StockTokens({ market, uniswap });
  return {
    quotes: new QuoteService({ maxAmount: config.quoteMaxAmount, tokens, uniswap, decimals }),
    swaps: new SwapService({ maxAmount: config.swapMaxAmount, tokens, uniswap, decimals }),
  };
}

/** Each field of a swap order, in the order they are checked, with its refusal. */
const SWAP_FIELDS: Record<string, { ok: (v: unknown) => boolean; error: string; message: string }> = {
  ticker: {
    ok: (v) => typeof v === "string" && TICKER.test(v),
    error: "invalid_ticker",
    message: "ticker must be a stock token symbol such as NVDA",
  },
  amountIn: {
    ok: (v) => typeof v === "string" && AMOUNT.test(v),
    error: "invalid_amount",
    message: "amountIn must be a positive whole number of atomic USDG, as a string",
  },
  swapper: {
    ok: (v) => typeof v === "string" && ADDRESS.test(v),
    error: "invalid_swapper",
    message: "swapper must be a 0x address",
  },
  slippageBps: {
    ok: (v) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 500,
    error: "invalid_slippage",
    message: "slippageBps must be a whole number from 1 to 500",
  },
};

export function tradeRoutes(trading: Trading): Hono {
  const app = new Hono();

  // Public to PerkOS and read only: no transaction, no signature. An identical
  // answer may be reused for as long as cache-control says.
  app.get("/quote", async (c) => {
    c.header("cache-control", "no-store");
    const ticker = single(c, "ticker");
    if (ticker === undefined || !TICKER.test(ticker)) {
      return refuse(c, 400, "invalid_ticker", "ticker must be a stock token symbol such as NVDA");
    }
    const amountIn = single(c, "amountIn");
    if (amountIn === undefined || !AMOUNT.test(amountIn)) {
      return refuse(c, 400, "invalid_amount", "amountIn must be a positive whole number of atomic USDG");
    }
    try {
      const answer = await trading.quotes.quote({ ticker, amountIn, client: clientOf(c) });
      c.header("cache-control", `public, max-age=${answer.maxAgeSeconds}`);
      return c.json(answer.quote);
    } catch (err) {
      if (err instanceof QuoteError) {
        if (err.retryAfterSeconds) c.header("retry-after", String(err.retryAfterSeconds));
        return refuse(c, err.status, err.code, err.message);
      }
      return refuse(c, 502, "uniswap_quote_failed", publicErrorMessage(err));
    }
  });

  // Returns calldata for the swapper to send. It never signs, never returns
  // permit data, and never answers for any router but Universal Router 2.1.1.
  const invalidBody = (c: Context) => {
    c.header("cache-control", "no-store");
    return refuse(c, 400, "invalid_request", "The body must be valid JSON of at most 128 KB");
  };
  app.post("/swap", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: invalidBody }), async (c) => {
    c.header("cache-control", "no-store");
    if (!/^application\/json\s*(;|$)/i.test(c.req.header("content-type") ?? "")) return invalidBody(c);
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return invalidBody(c);
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !Object.hasOwn(SWAP_FIELDS, key))
    ) {
      return refuse(
        c,
        400,
        "invalid_request",
        "The body must be a JSON object with only ticker, amountIn, swapper and slippageBps",
      );
    }
    const fields = body as Record<string, unknown>;
    for (const [name, field] of Object.entries(SWAP_FIELDS)) {
      if (!field.ok(fields[name])) return refuse(c, 400, field.error, field.message);
    }
    try {
      return c.json(
        await trading.swaps.swap({
          ticker: fields.ticker as string,
          amountIn: fields.amountIn as string,
          swapper: fields.swapper as `0x${string}`,
          slippageBps: fields.slippageBps as number,
          client: clientOf(c),
        }),
      );
    } catch (err) {
      if (err instanceof SwapError) {
        if (err.extra.retryAfterSeconds) c.header("retry-after", String(err.extra.retryAfterSeconds));
        // A 409 adds exactly token, spender and amount: the allowance to set on chain.
        return c.json({ error: err.code, message: err.message, ...err.extra.allowance }, err.status);
      }
      return refuse(c, 502, "uniswap_swap_failed", publicErrorMessage(err));
    }
  });

  return app;
}

/**
 * Who is asking, for the per-caller budgets: the first x-forwarded-for hop,
 * which PerkOS-API sets to the real caller, else PerkOS-API itself. The header
 * is trusted only because this service is internal and nothing but the API can
 * reach it. Published to the internet, anyone could claim a fresh identity per
 * request and the per-caller shares would mean nothing.
 */
function clientOf(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "perkos-api";
}

/** A query parameter given exactly once, or undefined. */
function single(c: Context, name: string): string | undefined {
  const values = c.req.queries(name);
  return values?.length === 1 ? values[0] : undefined;
}

function refuse(c: Context, status: Status, error: string, message: string) {
  return c.json({ error, message }, status);
}
