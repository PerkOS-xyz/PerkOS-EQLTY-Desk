/**
 * The price a desk agent reports: what the Uniswap Trading API quotes for
 * spending amountIn atomic USDG on one stock token. Read only: it never
 * builds a transaction and never signs.
 *
 * Nobody signs in to ask for a price. An agent calls on its own, so the
 * Trading API hears autonomous. What the agent does with the number still
 * goes through Risk and the person's hold.
 *
 * The Trading API key is shared, so three things keep a looping agent from
 * spending it: an identical question is answered from memory for 20 seconds,
 * a refusal (404 or 502) is repeated for 10 seconds without asking again, and
 * at most 120 fresh quotes start a minute, 20 of them per caller.
 */

import { USDG_ADDRESS, USDG_DECIMALS, ROBINHOOD_CHAIN_ID, type EvmAddress } from "./config.ts";
import { publicErrorMessage } from "./public-error.ts";
import type { TokenDecimalsReader } from "./token-decimals.ts";
import type { AssessedToken, StockTokens } from "./tokens.ts";
import type { DecisionOrigin, UniswapAttribution } from "./uniswap-attribution.ts";
import { quoteProtocols, type UniswapClient } from "./uniswap-client.ts";
import { UpstreamBudget } from "./upstream-budget.ts";

const ANSWER_SECONDS = 20;
const REFUSAL_SECONDS = 10;
const MAX_CACHED_ANSWERS = 256;
/** Each fresh quote can send two Trading API quotes: the check and the quote itself. */
const FRESH_QUOTES_PER_MINUTE = 120;
const FRESH_QUOTES_PER_CLIENT_PER_MINUTE = 20;

const decisionOrigin: DecisionOrigin = "autonomous";

export interface QuoteToken {
  symbol: string;
  address: EvmAddress;
  decimals: number;
}

export interface DeskQuote {
  chainId: 4663;
  ticker: string;
  tokenIn: QuoteToken;
  tokenOut: QuoteToken;
  amountIn: string;
  amountOut: string;
  priceImpactPct: number | null;
  /** The Trading API's routing value, or null when it sent none. */
  routing: string | null;
  protocols: string[];
  route: unknown[];
  gasFeeUsd: string | null;
  requestId: string | null;
  quotedAt: string;
  attribution: UniswapAttribution;
}

/** A quote and how many more seconds it may be reused. */
export interface QuoteAnswer {
  quote: DeskQuote;
  maxAgeSeconds: number;
}

export class QuoteError extends Error {
  readonly status: 400 | 404 | 429 | 502 | 503;
  readonly code: string;
  /** For a 429, the seconds until a fresh quote can start. */
  readonly retryAfterSeconds: number | undefined;

  constructor(status: 400 | 404 | 429 | 502 | 503, code: string, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "QuoteError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface QuoteDependencies {
  /** The largest amountIn priced, in atomic USDG. */
  maxAmount: bigint;
  tokens: Pick<StockTokens, "assess">;
  uniswap: Pick<UniswapClient, "quote" | "ready">;
  decimals: Pick<TokenDecimalsReader, "decimals" | "ready">;
  now?: () => number;
}

type CachedAnswer = { expiresAt: number; quote: DeskQuote } | { expiresAt: number; error: QuoteError };

export class QuoteService {
  private readonly maxAmount: bigint;
  private readonly tokens: Pick<StockTokens, "assess">;
  private readonly uniswap: Pick<UniswapClient, "quote" | "ready">;
  private readonly decimals: Pick<TokenDecimalsReader, "decimals" | "ready">;
  private readonly now: () => number;
  private readonly budget: UpstreamBudget;
  private readonly answers = new Map<string, CachedAnswer>();
  private readonly pending = new Map<string, Promise<CachedAnswer>>();

  constructor(dependencies: QuoteDependencies) {
    this.maxAmount = dependencies.maxAmount;
    this.tokens = dependencies.tokens;
    this.uniswap = dependencies.uniswap;
    this.decimals = dependencies.decimals;
    this.now = dependencies.now ?? Date.now;
    this.budget = new UpstreamBudget(FRESH_QUOTES_PER_MINUTE, 60_000, this.now, FRESH_QUOTES_PER_CLIENT_PER_MINUTE);
  }

  /** amountIn must already be a positive whole number string. */
  async quote(input: {
    ticker: string;
    amountIn: string;
    /** Who is asking, for its share of fresh quotes. */
    client?: string;
  }): Promise<QuoteAnswer> {
    const ticker = input.ticker.trim().toUpperCase();
    if (BigInt(input.amountIn) > this.maxAmount) {
      throw new QuoteError(
        400,
        "amount_above_limit",
        `amountIn is above this server's limit of ${this.maxAmount} atomic USDG`,
      );
    }
    if (!this.uniswap.ready()) {
      throw new QuoteError(503, "quote_unavailable", "Uniswap quoting is not configured on this server");
    }
    if (!this.decimals.ready()) {
      throw new QuoteError(
        503,
        "quote_unavailable",
        "The Robinhood Chain RPC that reads token decimals is not configured on this server",
      );
    }

    const key = `${ticker}:${input.amountIn}`;
    let answer = this.cached(key);
    if (!answer) {
      let pending = this.pending.get(key);
      if (!pending) {
        const retryAfterSeconds = this.budget.take(input.client);
        if (retryAfterSeconds > 0) {
          throw new QuoteError(
            429,
            "rate_limited",
            `Too many new quotes on this server; retry in ${retryAfterSeconds} seconds`,
            retryAfterSeconds,
          );
        }
        pending = this.fresh(key, ticker, input.amountIn).finally(() => {
          this.pending.delete(key);
        });
        this.pending.set(key, pending);
      }
      answer = await pending;
    }
    if ("error" in answer) throw answer.error;
    return {
      quote: answer.quote,
      maxAgeSeconds: Math.max(0, Math.ceil((answer.expiresAt - this.now()) / 1_000)),
    };
  }

  private cached(key: string): CachedAnswer | undefined {
    const answer = this.answers.get(key);
    return answer && answer.expiresAt > this.now() ? answer : undefined;
  }

  /** A fresh answer, or a 404 or 502 remembered for a short while. */
  private async fresh(key: string, ticker: string, amountIn: string): Promise<CachedAnswer> {
    try {
      const answer = await this.ask(ticker, amountIn);
      this.remember(key, answer);
      return answer;
    } catch (err) {
      if (err instanceof QuoteError && (err.status === 404 || err.status === 502)) {
        this.remember(key, { expiresAt: this.now() + REFUSAL_SECONDS * 1_000, error: err });
      }
      throw err;
    }
  }

  private async ask(ticker: string, amountIn: string): Promise<CachedAnswer> {
    let token: AssessedToken | undefined;
    try {
      token = await this.tokens.assess(ticker, decisionOrigin);
    } catch (err) {
      throw new QuoteError(502, "catalog_unavailable", publicErrorMessage(err, "The stock catalog is unavailable"));
    }
    if (!token) {
      throw new QuoteError(404, "asset_not_found", `${ticker} is not a Robinhood stock token on chain 4663`);
    }
    if (!token.routable) {
      throw new QuoteError(404, "not_uniswap_routable", `${ticker} has no observed Uniswap route`);
    }

    const [quoteResult, decimalsResult] = await Promise.allSettled([
      this.uniswap.quote(token.address, amountIn, decisionOrigin),
      this.decimals.decimals(token.address),
    ]);
    if (quoteResult.status === "rejected") {
      throw new QuoteError(
        502,
        "uniswap_quote_failed",
        publicErrorMessage(quoteResult.reason, "The Uniswap quote failed"),
      );
    }
    if (decimalsResult.status === "rejected") {
      throw new QuoteError(
        502,
        "token_decimals_unavailable",
        `The decimals of ${token.ticker} could not be read on Robinhood Chain`,
      );
    }
    const quote = quoteResult.value;
    const now = this.now();
    return {
      expiresAt: now + ANSWER_SECONDS * 1_000,
      quote: {
        chainId: ROBINHOOD_CHAIN_ID,
        ticker: token.ticker,
        tokenIn: { symbol: "USDG", address: USDG_ADDRESS, decimals: USDG_DECIMALS },
        tokenOut: { symbol: token.ticker, address: token.address, decimals: decimalsResult.value },
        amountIn,
        amountOut: quote.amountOut,
        priceImpactPct: quote.priceImpactPct ?? null,
        routing: quote.reportedRouting ?? null,
        protocols: [...quoteProtocols],
        route: quote.route ?? [],
        gasFeeUsd: quote.gasFeeUsd ?? null,
        requestId: quote.requestId ?? null,
        quotedAt: new Date(now).toISOString(),
        attribution: quote.attribution ?? { decisionOrigin, status: null },
      },
    };
  }

  /** Keeps live answers only, and at most MAX_CACHED_ANSWERS of them. */
  private remember(key: string, answer: CachedAnswer): void {
    const now = this.now();
    for (const [storedKey, stored] of this.answers) {
      if (stored.expiresAt <= now) this.answers.delete(storedKey);
    }
    this.answers.delete(key);
    this.answers.set(key, answer);
    while (this.answers.size > MAX_CACHED_ANSWERS) {
      const oldest = this.answers.keys().next().value;
      if (oldest === undefined) break;
      this.answers.delete(oldest);
    }
  }
}
