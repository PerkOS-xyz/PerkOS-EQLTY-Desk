/**
 * The market this desk answers with, against the shapes EQLTY really returns.
 * What is worth pinning down is what gets dropped and what gets flagged: those
 * two decisions reach a risk verdict, and a wrong one there costs money.
 */

import { describe, expect, it, vi } from "vitest";

import { DeskUnavailableError, EqltyMarket } from "../src/market.ts";

const ASSETS = {
  chainId: 4663,
  quoteToken: { symbol: "USDG" },
  observedAt: "2026-09-24T01:42:56.283Z",
  assets: [
    {
      ticker: "nvda",
      name: "NVIDIA • Robinhood Token",
      tokenAddress: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
      referencePrice: 225.27,
      referenceUpdatedAt: "2026-09-24T01:42:52.448Z",
      priceChange24hPct: -1.48,
      volume24hUsd: 24991268,
      uniswapRoutable: true,
      tradability: "TRADABLE",
      logoUrl: "https://cdn.example/nvda.png",
    },
    { ticker: "AAPL", tokenAddress: "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9", referencePrice: 336.9, uniswapRoutable: false },
    { ticker: "GOOG", referencePrice: 210 },
  ],
};

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const market = (http: typeof fetch) => new EqltyMarket({ baseUrl: "https://eqlty-api.example/", fetchImpl: http });

describe("the market this desk answers with", () => {
  it("names the chain and the asset an order is priced in", async () => {
    const out = await market(vi.fn(async () => ok(ASSETS)) as unknown as typeof fetch).market();
    expect(out.chain).toBe("robinhood");
    expect(out.chainId).toBe(4663);
    expect(out.quoteSymbol).toBe("USDG");
  });

  it("drops what is not a market and flags what cannot be routed", async () => {
    const out = await market(vi.fn(async () => ok(ASSETS)) as unknown as typeof fetch).market();
    expect(out.assets.map((a) => a.ticker)).toEqual(["NVDA", "AAPL"]);
    expect(out.assets[0]?.tradeable).toBe(true);
    expect(out.assets[1]?.tradeable).toBe(false);
  });

  it("refuses to answer with an empty market", async () => {
    const http = vi.fn(async () => ok({ ...ASSETS, assets: [] }));
    await expect(market(http as unknown as typeof fetch).market()).rejects.toBeInstanceOf(DeskUnavailableError);
  });

  it("says the market is down rather than inventing one", async () => {
    const down = vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response);
    await expect(market(down as unknown as typeof fetch).market()).rejects.toThrow(/503/);
    const silent = vi.fn(async () => Promise.reject(new Error("timed out")));
    await expect(market(silent as unknown as typeof fetch).market()).rejects.toThrow(/did not answer/);
  });
});

describe("the history a turn cites", () => {
  it("asks once for the tickers it was given and carries the source", async () => {
    const http = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain("tickers=NVDA%2CAAPL");
      return ok({
        source: "uniswap-rwa-1d",
        series: [
          {
            ticker: "nvda",
            priceUsd: 225.27,
            priceChange24hPct: -1.48,
            points: [
              { at: "2026-09-23T02:37:01.000Z", value: 228.72 },
              { at: "", value: 1 },
              { at: "2026-09-23T03:37:01.000Z", value: 0 },
            ],
          },
        ],
      });
    });
    const out = await market(http as unknown as typeof fetch).series(["nvda", "NVDA", "aapl"]);
    expect(http).toHaveBeenCalledTimes(1);
    expect(out[0]?.ticker).toBe("NVDA");
    expect(out[0]?.source).toBe("uniswap-rwa-1d");
    // A point with no time, or no price, is not a measurement.
    expect(out[0]?.points).toHaveLength(1);
  });

  it("asks nothing when there is nothing to ask", async () => {
    const http = vi.fn(async () => ok({}));
    expect(await market(http as unknown as typeof fetch).series([])).toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });
});
