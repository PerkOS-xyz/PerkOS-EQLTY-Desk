/**
 * Which stock token a ticker names, read from this desk's own market.
 *
 * The quote and swap routes need two things per ticker: the token address,
 * and whether the market reports it tradeable. The market is read at most
 * once a minute here, and when it is briefly down the last good answer is
 * used, so a burst of orders, or of junk tickers, costs the market nothing.
 *
 * How routability is judged:
 *
 *   - A row the market reports tradeable is routable.
 *   - A row reported untradeable can still be priced if a check quote of
 *     1 USDG succeeds right now (assess). A swap trusts the market's flag
 *     alone and never runs the check.
 *
 * The market's flag is a little stricter than "Uniswap has a route": it is
 * also off when Robinhood marks the token NOT_TRADABLE. So such a token can
 * be priced after a check but is not swapped. A tradeable row skips the
 * check quote, because its answer could not change the verdict and it would
 * spend a Trading API call.
 */

import { ROBINHOOD_CHAIN_ID, type EvmAddress } from "./config.ts";
import type { EqltyMarket } from "./market.ts";
import type { DecisionOrigin } from "./uniswap-attribution.ts";
import type { UniswapClient } from "./uniswap-client.ts";

const CACHE_MS = 60_000;
/** How long the last good list is served again while the market is down. */
const STALE_RETRY_MS = 10_000;
/** 1 USDG, the size of the check quote for a row the market reports untradeable. */
const CHECK_AMOUNT = "1000000";

export interface StockToken {
  ticker: string;
  address: EvmAddress;
  tradeable: boolean;
}

export interface AssessedToken extends StockToken {
  /** Tradeable on the market, or quoted by Uniswap just now. */
  routable: boolean;
}

export interface TokenSource {
  market: Pick<EqltyMarket, "market">;
  /** Runs the check quote. Without it an untradeable row stays unroutable. */
  uniswap?: Pick<UniswapClient, "quote" | "ready">;
  now?: () => number;
}

export class StockTokens {
  private readonly market: Pick<EqltyMarket, "market">;
  private readonly uniswap: Pick<UniswapClient, "quote" | "ready"> | undefined;
  private readonly now: () => number;
  private cached: { expiresAt: number; tokens: Map<string, StockToken> } | undefined;
  private pending: Promise<Map<string, StockToken>> | undefined;

  constructor(source: TokenSource) {
    this.market = source.market;
    this.uniswap = source.uniswap;
    this.now = source.now ?? Date.now;
  }

  /** The token a ticker names, or undefined. Throws when the market cannot answer. */
  async find(ticker: string): Promise<StockToken | undefined> {
    return (await this.tokens()).get(ticker.trim().toUpperCase());
  }

  /** find, plus whether a price can be asked for it. */
  async assess(ticker: string, decisionOrigin: DecisionOrigin): Promise<AssessedToken | undefined> {
    const token = await this.find(ticker);
    if (!token) return undefined;
    if (token.tradeable) return { ...token, routable: true };
    if (!this.uniswap?.ready()) return { ...token, routable: false };
    try {
      await this.uniswap.quote(token.address, CHECK_AMOUNT, decisionOrigin);
      return { ...token, routable: true };
    } catch {
      return { ...token, routable: false };
    }
  }

  private tokens(): Promise<Map<string, StockToken>> {
    if (this.cached && this.cached.expiresAt > this.now()) return Promise.resolve(this.cached.tokens);
    if (!this.pending) {
      this.pending = this.read()
        .then((tokens) => {
          this.cached = { expiresAt: this.now() + CACHE_MS, tokens };
          return tokens;
        })
        .catch((err: unknown) => {
          if (!this.cached) throw err;
          // Keep the last good list a little longer, so each request during an
          // outage does not wait on the market again.
          this.cached = { expiresAt: this.now() + STALE_RETRY_MS, tokens: this.cached.tokens };
          return this.cached.tokens;
        })
        .finally(() => {
          this.pending = undefined;
        });
    }
    return this.pending;
  }

  private async read(): Promise<Map<string, StockToken>> {
    const market = await this.market.market();
    if (market.chainId !== ROBINHOOD_CHAIN_ID) throw new Error("The market is not on Robinhood Chain");
    const tokens = new Map<string, StockToken>();
    for (const asset of market.assets) {
      const ticker = asset.ticker.toUpperCase();
      // An address that is not one cannot be quoted or swapped; the first row for a ticker wins.
      if (!/^0x[0-9a-fA-F]{40}$/.test(asset.address) || tokens.has(ticker)) continue;
      tokens.set(ticker, { ticker, address: asset.address as EvmAddress, tradeable: asset.tradeable === true });
    }
    return tokens;
  }
}
