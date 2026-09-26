/**
 * How a ticker becomes a token for the trading routes. Two decisions here
 * reach an order: which rows count as a token at all, and when an untradeable
 * row may still be priced. The market is also read sparingly, so a burst of
 * orders does not become a burst of calls to it.
 */

import { describe, expect, it, vi } from "vitest";

import type { DeskAsset, DeskMarket } from "../src/contract.ts";
import { StockTokens } from "../src/tokens.ts";
import type { UniswapQuote } from "../src/uniswap-client.ts";

const nvda = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const aapl = "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9";
const start = Date.parse("2026-09-26T12:00:00.000Z");

const asset = (over: Partial<DeskAsset>): DeskAsset => ({
  ticker: "NVDA",
  name: "NVIDIA",
  address: nvda,
  decimals: 18,
  priceUsd: 180,
  priceAt: null,
  change24hPct: null,
  volume24hUsd: null,
  tradeable: true,
  logoUrl: null,
  ...over,
});

const deskMarket = (assets: DeskAsset[], chainId = 4663): DeskMarket => ({
  chain: "robinhood",
  chainId,
  quoteSymbol: "USDG",
  assets,
  observedAt: "2026-09-26T12:00:00.000Z",
});

const ROWS = [
  asset({}),
  asset({ ticker: "AAPL", address: aapl, tradeable: false }),
  asset({ ticker: "GOOG", address: "not-an-address" }),
  asset({ ticker: "NVDA", address: aapl }),
];

function setup(
  over: { market?: () => Promise<DeskMarket>; quote?: () => Promise<UniswapQuote>; ready?: boolean } = {},
) {
  let now = start;
  const market = { market: vi.fn(over.market ?? (async () => deskMarket(ROWS))) };
  const uniswap = {
    ready: () => over.ready ?? true,
    quote: vi.fn(over.quote ?? (async (): Promise<UniswapQuote> => ({ amountOut: "1", routing: "V4" }))),
  };
  const tokens = new StockTokens({ market, uniswap, now: () => now });
  return { tokens, market, uniswap, advance: (ms: number) => (now += ms) };
}

describe("the tokens a ticker names", () => {
  it("finds a token in any case and keeps the market's tradeable flag", async () => {
    const { tokens } = setup();

    expect(await tokens.find(" nvda ")).toEqual({ ticker: "NVDA", address: nvda, tradeable: true });
    expect(await tokens.find("AAPL")).toEqual({ ticker: "AAPL", address: aapl, tradeable: false });
    expect(await tokens.find("ZZZZ")).toBeUndefined();
  });

  it("drops a row whose address is not one, and keeps the first row for a ticker", async () => {
    const { tokens } = setup();

    expect(await tokens.find("GOOG")).toBeUndefined();
    expect((await tokens.find("NVDA"))?.address).toBe(nvda);
  });

  it("calls a tradeable row routable without spending a check quote", async () => {
    const { tokens, uniswap } = setup();

    expect(await tokens.assess("NVDA", "autonomous")).toMatchObject({ routable: true });
    expect(uniswap.quote).not.toHaveBeenCalled();
  });

  it("prices an untradeable row only when a 1 USDG check quote succeeds now", async () => {
    const quoted = setup();
    expect(await quoted.tokens.assess("AAPL", "autonomous")).toMatchObject({ ticker: "AAPL", routable: true });
    expect(quoted.uniswap.quote).toHaveBeenCalledWith(aapl, "1000000", "autonomous");

    const refused = setup({
      quote: async () => {
        throw new Error("Uniswap quote failed with status 404");
      },
    });
    expect(await refused.tokens.assess("AAPL", "autonomous")).toMatchObject({ routable: false });

    const keyless = setup({ ready: false });
    expect(await keyless.tokens.assess("AAPL", "autonomous")).toMatchObject({ routable: false });
    expect(keyless.uniswap.quote).not.toHaveBeenCalled();
  });

  it("reads the market at most once a minute, once for callers that arrive together", async () => {
    const { tokens, market, advance } = setup();

    await Promise.all([tokens.find("NVDA"), tokens.find("AAPL"), tokens.find("ZZZZ")]);
    advance(59_000);
    await tokens.find("NVDA");
    expect(market.market).toHaveBeenCalledTimes(1);

    advance(1_000);
    await tokens.find("NVDA");
    expect(market.market).toHaveBeenCalledTimes(2);
  });

  it("keeps answering from the last good market while the market is down", async () => {
    let down = false;
    const { tokens, advance } = setup({
      market: async () => {
        if (down) throw new Error("The EQLTY market answered 503");
        return deskMarket(ROWS);
      },
    });

    await tokens.find("NVDA");
    down = true;
    advance(61_000);
    expect(await tokens.find("NVDA")).toMatchObject({ ticker: "NVDA" });
  });

  it("does not ask the market again on every request while it is down", async () => {
    let down = false;
    let reads = 0;
    const { tokens, advance } = setup({
      market: async () => {
        reads += 1;
        if (down) throw new Error("The EQLTY market answered 503");
        return deskMarket(ROWS);
      },
    });

    await tokens.find("NVDA");
    down = true;
    advance(61_000);
    await tokens.find("NVDA");
    await tokens.find("TSLA");
    expect(reads).toBe(2);
    advance(11_000);
    await tokens.find("NVDA");
    expect(reads).toBe(3);
  });

  it("says the market is down when it never answered, and refuses another chain", async () => {
    const down = setup({
      market: async () => {
        throw new Error("The EQLTY market answered 503");
      },
    });
    await expect(down.tokens.find("NVDA")).rejects.toThrow("503");

    const elsewhere = setup({ market: async () => deskMarket(ROWS, 1) });
    await expect(elsewhere.tokens.find("NVDA")).rejects.toThrow("not on Robinhood Chain");
  });
});
