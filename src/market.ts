/**
 * What this desk can trade, and what it is worth.
 *
 * The prices, the catalogue and the day's history come from the EQLTY API,
 * which already resolves them against Robinhood's own endpoints and watches
 * the Uniswap RWA market on chain. This file's whole job is to turn that into
 * the shape every Desk answers with, and to drop what cannot be traded.
 *
 * Two rules it keeps, because they end up inside a risk verdict:
 *
 *   - A row without a ticker or an address is not a market. It is dropped.
 *   - A row that is priced but cannot be routed is reported as untradeable,
 *     never quietly hidden, so a person can see it exists and why it is off.
 */

import type { DeskAsset, DeskMarket, DeskSeries } from "./contract.ts";

const ROBINHOOD_CHAIN_ID = 4663;
const TIMEOUT_MS = 12_000;

export interface MarketSource {
  /** Where the EQLTY API lives. */
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export class DeskUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeskUnavailableError";
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export class EqltyMarket {
  private readonly baseUrl: string;
  private readonly http: typeof fetch;

  constructor(source: MarketSource) {
    this.baseUrl = source.baseUrl.replace(/\/+$/, "");
    this.http = source.fetchImpl ?? fetch;
  }

  private async read(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await this.http(`${this.baseUrl}${path}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new DeskUnavailableError(`The EQLTY market did not answer: ${(err as Error).message}`);
    }
    if (!res.ok) throw new DeskUnavailableError(`The EQLTY market answered ${res.status}`);
    return res.json().catch(() => {
      throw new DeskUnavailableError("The EQLTY market answered something that is not JSON");
    });
  }

  async market(): Promise<DeskMarket> {
    const body = (await this.read("/api/assets")) as {
      chainId?: unknown;
      quoteToken?: unknown;
      observedAt?: unknown;
      assets?: unknown;
    };
    const rows = Array.isArray(body.assets) ? (body.assets as Array<Record<string, unknown>>) : [];
    const assets = rows.map(toAsset).filter((a): a is DeskAsset => a !== null);
    if (!assets.length) throw new DeskUnavailableError("The EQLTY market returned no assets");
    const quote = body.quoteToken;
    return {
      chain: "robinhood",
      chainId: num(body.chainId) ?? ROBINHOOD_CHAIN_ID,
      quoteSymbol:
        (typeof quote === "object" && quote !== null ? str((quote as { symbol?: unknown }).symbol) : str(quote)) ?? "USDG",
      assets,
      observedAt: str(body.observedAt) ?? new Date().toISOString(),
    };
  }

  async series(tickers: string[]): Promise<DeskSeries[]> {
    const wanted = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))].slice(0, 24);
    if (!wanted.length) return [];
    const body = (await this.read(`/api/assets/history?tickers=${encodeURIComponent(wanted.join(","))}`)) as {
      source?: unknown;
      series?: unknown;
    };
    const rows = Array.isArray(body.series) ? (body.series as Array<Record<string, unknown>>) : [];
    const source = str(body.source) ?? "eqlty";
    return rows
      .map((row) => {
        const ticker = str(row.ticker)?.toUpperCase();
        if (!ticker) return null;
        const points = (Array.isArray(row.points) ? (row.points as Array<Record<string, unknown>>) : [])
          .map((p) => ({ at: str(p.at) ?? "", value: num(p.value) ?? 0 }))
          .filter((p) => p.at !== "" && p.value > 0);
        return { ticker, priceUsd: num(row.priceUsd), change24hPct: num(row.priceChange24hPct), points, source };
      })
      .filter((s): s is DeskSeries => s !== null);
  }
}

function toAsset(row: Record<string, unknown>): DeskAsset | null {
  const ticker = str(row.ticker)?.toUpperCase();
  const address = str(row.tokenAddress);
  if (!ticker || !address) return null;
  return {
    ticker,
    name: str(row.name) ?? ticker,
    address,
    decimals: num(row.decimals) ?? 18,
    priceUsd: num(row.referencePrice),
    priceAt: str(row.referenceUpdatedAt),
    change24hPct: num(row.priceChange24hPct),
    volume24hUsd: num(row.volume24hUsd),
    tradeable: row.uniswapRoutable === true && str(row.tradability) !== "NOT_TRADABLE",
    logoUrl: str(row.logoUrl),
  };
}
