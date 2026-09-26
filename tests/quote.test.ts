/**
 * The price an agent reports. Besides the shape of the answer, what matters
 * is what it costs: identical questions are answered from memory, refusals
 * are repeated for a while without asking again, and fresh quotes are
 * budgeted per caller and overall, because the Trading API key is shared.
 */

import { describe, expect, it, vi } from "vitest";

import { QuoteService } from "../src/quote.ts";
import type { AssessedToken } from "../src/tokens.ts";
import type { UniswapQuote } from "../src/uniswap-client.ts";

const usdg = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const nvda = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const start = Date.parse("2026-09-26T12:00:00.000Z");
const route = [
  [
    {
      type: "v4-pool",
      address: "0x1111111111111111111111111111111111111111",
      fee: "3000",
      tickSpacing: "60",
      hooks: "0x0000000000000000000000000000000000000000",
    },
  ],
];

describe("quote", () => {
  it("returns the Trading API quote as an agent reads it", async () => {
    const { service, tokens, uniswap, decimals } = setup();

    const answer = await service.quote({ ticker: "nvda", amountIn: "1000000" });

    expect(answer).toEqual({
      maxAgeSeconds: 20,
      quote: {
        chainId: 4663,
        ticker: "NVDA",
        tokenIn: { symbol: "USDG", address: usdg, decimals: 6 },
        tokenOut: { symbol: "NVDA", address: nvda, decimals: 18 },
        amountIn: "1000000",
        amountOut: "5500000000000000",
        priceImpactPct: 0.42,
        routing: "CLASSIC",
        protocols: ["V4"],
        route,
        gasFeeUsd: "0.0031",
        requestId: "quote-agent-1",
        quotedAt: "2026-09-26T12:00:00.000Z",
        attribution: { decisionOrigin: "autonomous", status: null },
      },
    });
    expect(tokens.assess).toHaveBeenCalledWith("NVDA", "autonomous");
    expect(uniswap.quote).toHaveBeenCalledWith(nvda, "1000000", "autonomous");
    expect(decimals.decimals).toHaveBeenCalledWith(nvda);
  });

  it("says plainly when the Trading API leaves a field out", async () => {
    // routing is the client's "V4" fallback; the API itself sent none.
    const { service } = setup({ quote: async () => ({ amountOut: "7", routing: "V4" }) });

    const { quote } = await service.quote({ ticker: "NVDA", amountIn: "1000000" });

    expect(quote).toMatchObject({
      priceImpactPct: null,
      routing: null,
      route: [],
      gasFeeUsd: null,
      requestId: null,
      attribution: { decisionOrigin: "autonomous", status: null },
    });
  });

  it("surfaces a malformed X-Agent-Info status from the gateway", async () => {
    const { service } = setup({
      quote: async () => ({ ...liveQuote(), attribution: { decisionOrigin: "autonomous", status: "malformed" } }),
    });

    const { quote } = await service.quote({ ticker: "NVDA", amountIn: "1000000" });

    expect(quote.attribution).toEqual({ decisionOrigin: "autonomous", status: "malformed" });
  });

  it("reuses an identical answer for 20 seconds", async () => {
    let now = start;
    const { service, uniswap } = setup({ now: () => now });

    const first = await service.quote({ ticker: "NVDA", amountIn: "1000000" });
    now = start + 19_000;
    const second = await service.quote({ ticker: "nvda", amountIn: "1000000" });

    expect(second.quote).toBe(first.quote);
    expect(second.maxAgeSeconds).toBe(1);
    expect(uniswap.quote).toHaveBeenCalledTimes(1);

    now = start + 20_000;
    const third = await service.quote({ ticker: "NVDA", amountIn: "1000000" });

    expect(third.quote.quotedAt).toBe("2026-09-26T12:00:20.000Z");
    expect(third.maxAgeSeconds).toBe(20);
    expect(uniswap.quote).toHaveBeenCalledTimes(2);
  });

  it("asks once for identical questions that arrive together", async () => {
    const { service, uniswap } = setup();

    const answers = await Promise.all([
      service.quote({ ticker: "NVDA", amountIn: "1000000" }),
      service.quote({ ticker: "NVDA", amountIn: "1000000" }),
      service.quote({ ticker: "NVDA", amountIn: "1000000" }),
    ]);

    expect(new Set(answers.map((answer) => answer.quote)).size).toBe(1);
    expect(uniswap.quote).toHaveBeenCalledTimes(1);
  });

  it("quotes a different size separately", async () => {
    const { service, uniswap } = setup();

    await service.quote({ ticker: "NVDA", amountIn: "1000000" });
    await service.quote({ ticker: "NVDA", amountIn: "500000" });

    expect(uniswap.quote).toHaveBeenCalledTimes(2);
    expect(uniswap.quote).toHaveBeenLastCalledWith(nvda, "500000", "autonomous");
  });

  it("refuses an amount above the server limit before asking anyone", async () => {
    const { service, tokens, uniswap } = setup();

    await expect(service.quote({ ticker: "NVDA", amountIn: "100000001" })).rejects.toMatchObject({
      status: 400,
      code: "amount_above_limit",
      message: "amountIn is above this server's limit of 100000000 atomic USDG",
    });
    expect(tokens.assess).not.toHaveBeenCalled();
    expect(uniswap.quote).not.toHaveBeenCalled();
  });

  it("prices any size up to its own limit", async () => {
    const { service } = setup({ maxAmount: 300_000_000n });

    await expect(service.quote({ ticker: "NVDA", amountIn: "300000000" })).resolves.toMatchObject({
      quote: { amountIn: "300000000" },
    });
    await expect(service.quote({ ticker: "NVDA", amountIn: "300000001" })).rejects.toMatchObject({
      status: 400,
      code: "amount_above_limit",
    });
  });

  it("refuses a ticker that is not in the market", async () => {
    const { service, uniswap } = setup({ assess: async () => undefined });

    await expect(service.quote({ ticker: "ZZZZ", amountIn: "1000000" })).rejects.toMatchObject({
      status: 404,
      code: "asset_not_found",
      message: "ZZZZ is not a Robinhood stock token on chain 4663",
    });
    expect(uniswap.quote).not.toHaveBeenCalled();
  });

  it("refuses a stock token with no observed Uniswap route", async () => {
    const { service, uniswap } = setup({ assess: async () => token({ tradeable: false, routable: false }) });

    await expect(service.quote({ ticker: "NVDA", amountIn: "1000000" })).rejects.toMatchObject({
      status: 404,
      code: "not_uniswap_routable",
      message: "NVDA has no observed Uniswap route",
    });
    expect(uniswap.quote).not.toHaveBeenCalled();
  });

  it("prices an untradeable token the check quote cleared", async () => {
    const { service } = setup({ assess: async () => token({ tradeable: false, routable: true }) });

    await expect(service.quote({ ticker: "NVDA", amountIn: "1000000" })).resolves.toMatchObject({
      quote: { ticker: "NVDA" },
    });
  });

  it("reports a Trading API failure as a public-safe 502 and repeats it for 10 seconds", async () => {
    let now = start;
    const quote = vi
      .fn<() => Promise<UniswapQuote>>()
      .mockRejectedValueOnce(new Error("request body: https://trade-api.gateway.uniswap.org/v1"))
      .mockResolvedValueOnce(liveQuote());
    const { service, tokens } = setup({ quote, now: () => now });
    const failure = {
      status: 502,
      code: "uniswap_quote_failed",
      message: "The external provider rejected the request.",
    };

    await expect(service.quote({ ticker: "NVDA", amountIn: "1000000" })).rejects.toMatchObject(failure);
    now = start + 9_000;
    await expect(service.quote({ ticker: "NVDA", amountIn: "1000000" })).rejects.toMatchObject(failure);
    expect(quote).toHaveBeenCalledTimes(1);
    expect(tokens.assess).toHaveBeenCalledTimes(1);

    now = start + 10_000;
    await expect(service.quote({ ticker: "NVDA", amountIn: "1000000" })).resolves.toMatchObject({
      quote: { amountOut: "5500000000000000" },
    });
    expect(quote).toHaveBeenCalledTimes(2);
  });

  it("repeats a not-routable refusal without asking the market again", async () => {
    const { service, tokens } = setup({ assess: async () => token({ tradeable: false, routable: false }) });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(service.quote({ ticker: "NVDA", amountIn: "1000000" })).rejects.toMatchObject({
        status: 404,
        code: "not_uniswap_routable",
      });
    }
    expect(tokens.assess).toHaveBeenCalledTimes(1);
  });

  it("gives each caller 20 new quotes a minute, so one caller cannot starve the others", async () => {
    let now = start;
    const { service, uniswap } = setup({ now: () => now });
    for (let amount = 1; amount <= 20; amount += 1) {
      await service.quote({ ticker: "NVDA", amountIn: String(amount), client: "a" });
    }

    now = start + 15_000;
    await expect(service.quote({ ticker: "NVDA", amountIn: "21", client: "a" })).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      retryAfterSeconds: 45,
    });
    // A cached answer is still served while the caller's share is spent.
    await expect(service.quote({ ticker: "NVDA", amountIn: "20", client: "a" })).resolves.toMatchObject({
      quote: { amountIn: "20" },
    });
    // Another caller keeps its own share.
    await expect(service.quote({ ticker: "NVDA", amountIn: "21", client: "b" })).resolves.toMatchObject({
      quote: { amountIn: "21" },
    });
    expect(uniswap.quote).toHaveBeenCalledTimes(21);

    now = start + 60_000;
    await expect(service.quote({ ticker: "NVDA", amountIn: "22", client: "a" })).resolves.toMatchObject({
      quote: { amountIn: "22" },
    });
  });

  it("still caps the whole server at 120 new quotes a minute", async () => {
    const { service } = setup();
    for (let amount = 1; amount <= 120; amount += 1) {
      await service.quote({ ticker: "NVDA", amountIn: String(amount), client: `c${amount % 7}` });
    }
    await expect(service.quote({ ticker: "NVDA", amountIn: "121", client: "fresh" })).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
    });
  });

  it("reports the stock token decimals read on chain", async () => {
    const { service } = setup({ decimals: async () => 8 });

    const { quote } = await service.quote({ ticker: "NVDA", amountIn: "1000000" });

    expect(quote.tokenOut).toEqual({ symbol: "NVDA", address: nvda, decimals: 8 });
  });

  it("refuses to report a quote whose token decimals could not be read", async () => {
    const { service } = setup({
      decimals: async () => {
        throw new Error("execution reverted");
      },
    });

    await expect(service.quote({ ticker: "NVDA", amountIn: "1000000" })).rejects.toMatchObject({
      status: 502,
      code: "token_decimals_unavailable",
      message: "The decimals of NVDA could not be read on Robinhood Chain",
    });
  });

  it("reports an unavailable market as a 502", async () => {
    const { service } = setup({
      assess: async () => {
        throw new Error("The EQLTY market answered 503");
      },
    });

    await expect(service.quote({ ticker: "NVDA", amountIn: "1000000" })).rejects.toMatchObject({
      status: 502,
      code: "catalog_unavailable",
      message: "The EQLTY market answered 503",
    });
  });

  it.each([
    ["the Trading API key", { ready: () => false }],
    ["the decimals RPC", { decimalsReady: () => false }],
  ])("says so when %s is not configured", async (_label, over) => {
    const { service, tokens } = setup(over);

    await expect(service.quote({ ticker: "NVDA", amountIn: "1000000" })).rejects.toMatchObject({
      status: 503,
      code: "quote_unavailable",
    });
    expect(tokens.assess).not.toHaveBeenCalled();
  });
});

function setup(
  over: {
    quote?: (...args: never[]) => Promise<UniswapQuote>;
    ready?: () => boolean;
    decimals?: (token: string) => Promise<number>;
    decimalsReady?: () => boolean;
    assess?: (ticker: string) => Promise<AssessedToken | undefined>;
    maxAmount?: bigint;
    now?: () => number;
  } = {},
) {
  const tokens = { assess: vi.fn(over.assess ?? (async () => token())) };
  const uniswap = { ready: over.ready ?? (() => true), quote: vi.fn(over.quote ?? (async () => liveQuote())) };
  const decimals = {
    ready: over.decimalsReady ?? (() => true),
    decimals: vi.fn(over.decimals ?? (async () => 18)),
  };
  const service = new QuoteService({
    maxAmount: over.maxAmount ?? 100_000_000n,
    tokens,
    uniswap,
    decimals,
    now: over.now ?? (() => start),
  });
  return { service, tokens, uniswap, decimals };
}

function liveQuote(): UniswapQuote {
  return {
    amountOut: "5500000000000000",
    requestId: "quote-agent-1",
    routing: "CLASSIC",
    reportedRouting: "CLASSIC",
    priceImpactPct: 0.42,
    route,
    gasFeeUsd: "0.0031",
    attribution: { decisionOrigin: "autonomous", status: null },
  };
}

function token(over: Partial<AssessedToken> = {}): AssessedToken {
  return { ticker: "NVDA", address: nvda, tradeable: true, routable: true, ...over };
}
