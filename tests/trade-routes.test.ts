/**
 * The trading routes over HTTP. Input is refused here before any service
 * sees it, every refusal keeps its status and code, and a 409 carries the
 * allowance to set and nothing else. The last group runs the real services
 * over a fake fetch, to show the pieces agree end to end: the headers every
 * Trading API call carries, and that the key never comes back out.
 */

import { describe, expect, it, vi } from "vitest";

import { loadTradingConfig } from "../src/config.ts";
import type { DeskMarket } from "../src/contract.ts";
import type { EqltyMarket } from "../src/market.ts";
import { QuoteError, type QuoteAnswer } from "../src/quote.ts";
import { createApp } from "../src/server.ts";
import { SwapError, type DeskSwap } from "../src/swap.ts";
import { createTrading, type Trading } from "../src/trade-routes.ts";

const usdg = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const nvda = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const router = "0x8876789976decbfcbbbe364623c63652db8c0904";
const permit2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const owner = "0x1234567890abcdef1234567890abcdef12345678";
const swapData = `0x3593564c${"00".repeat(32)}`;

const deskMarket: DeskMarket = {
  chain: "robinhood",
  chainId: 4663,
  quoteSymbol: "USDG",
  assets: [
    {
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
    },
  ],
  observedAt: "2026-09-26T12:00:00.000Z",
};
const market = { market: async () => deskMarket, series: async () => [] } as unknown as EqltyMarket;

const app = (trading: Partial<Trading>) =>
  createApp(market, {
    quotes: trading.quotes ?? { quote: vi.fn() },
    swaps: trading.swaps ?? { swap: vi.fn() },
  });

/** The real services, built from the environment given, over a fake fetch. */
const real = (env: Record<string, string>, http: typeof fetch = vi.fn<typeof fetch>()) =>
  createApp(market, createTrading(market, loadTradingConfig(env), http));

describe("GET /quote", () => {
  const answer: QuoteAnswer = {
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
      route: [],
      gasFeeUsd: "0.0031",
      requestId: "quote-agent-1",
      quotedAt: "2026-09-26T12:00:00.000Z",
      attribution: { decisionOrigin: "autonomous", status: null },
    },
  };

  it("answers a read-only quote and says how long it may be reused", async () => {
    const quote = vi.fn(async () => answer);

    const res = await app({ quotes: { quote } }).request("/quote?ticker=nvda&amountIn=1000000");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=20");
    expect(await res.json()).toEqual(answer.quote);
    expect(quote).toHaveBeenCalledWith({ ticker: "nvda", amountIn: "1000000", client: "perkos-api" });
  });

  it("budgets by the first x-forwarded-for hop PerkOS-API sets", async () => {
    const quote = vi.fn(async () => answer);

    await app({ quotes: { quote } }).request("/quote?ticker=NVDA&amountIn=1000000", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.2" },
    });

    expect(quote).toHaveBeenCalledWith(expect.objectContaining({ client: "203.0.113.7" }));
  });

  it.each([
    ["a missing ticker", "?amountIn=1000000", "invalid_ticker"],
    ["a malformed ticker", "?ticker=NV%20DA&amountIn=1000000", "invalid_ticker"],
    ["a repeated ticker", "?ticker=NVDA&ticker=AMZN&amountIn=1000000", "invalid_ticker"],
    ["a missing amount", "?ticker=NVDA", "invalid_amount"],
    ["a repeated amount", "?ticker=NVDA&amountIn=1&amountIn=2", "invalid_amount"],
    ["a zero amount", "?ticker=NVDA&amountIn=0", "invalid_amount"],
    ["a negative amount", "?ticker=NVDA&amountIn=-1", "invalid_amount"],
    ["a fractional amount", "?ticker=NVDA&amountIn=1.5", "invalid_amount"],
    ["an exponent", "?ticker=NVDA&amountIn=1e6", "invalid_amount"],
    ["a word", "?ticker=NVDA&amountIn=all", "invalid_amount"],
    ["an amount over 78 digits", `?ticker=NVDA&amountIn=${"9".repeat(79)}`, "invalid_amount"],
    ["a leading zero", "?ticker=NVDA&amountIn=01", "invalid_amount"],
  ])("refuses %s with 400", async (_label, query, error) => {
    const quote = vi.fn(async () => answer);

    const res = await app({ quotes: { quote } }).request(`/quote${query}`);

    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error, message: expect.any(String) });
    expect(quote).not.toHaveBeenCalled();
  });

  it("refuses an amount above the server limit", async () => {
    const res = await real({ EQLTY_AGENT_QUOTE_MAX_AMOUNT: "1000000" }).request("/quote?ticker=NVDA&amountIn=1000001");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "amount_above_limit",
      message: "amountIn is above this server's limit of 1000000 atomic USDG",
    });
  });

  it.each([
    [404, "not_uniswap_routable", "NVDA has no observed Uniswap route"],
    [404, "asset_not_found", "ZZZZ is not a Robinhood stock token on chain 4663"],
    [502, "uniswap_quote_failed", "Uniswap quote failed with status 500"],
    [502, "token_decimals_unavailable", "The decimals of NVDA could not be read on Robinhood Chain"],
    [502, "catalog_unavailable", "The EQLTY market answered 503"],
    [503, "quote_unavailable", "Uniswap quoting is not configured on this server"],
  ] as const)("answers a %i %s refusal with its message", async (status, code, message) => {
    const quote = async () => {
      throw new QuoteError(status, code, message);
    };

    const res = await app({ quotes: { quote } }).request("/quote?ticker=NVDA&amountIn=1000000");

    expect(res.status).toBe(status);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: code, message });
  });

  it("tells a rate-limited agent when to retry", async () => {
    const quote = async () => {
      throw new QuoteError(429, "rate_limited", "Too many new quotes on this server; retry in 12 seconds", 12);
    };

    const res = await app({ quotes: { quote } }).request("/quote?ticker=NVDA&amountIn=1000000");

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("12");
    expect(await res.json()).toEqual({
      error: "rate_limited",
      message: "Too many new quotes on this server; retry in 12 seconds",
    });
  });

  it("keeps an unexpected failure public-safe", async () => {
    const quote = async () => {
      throw new Error('request body: {"x-api-key":"secret"}');
    };

    const res = await app({ quotes: { quote } }).request("/quote?ticker=NVDA&amountIn=1000000");

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "uniswap_quote_failed",
      message: "The external provider rejected the request.",
    });
  });
});

describe("POST /swap", () => {
  const swap: DeskSwap = {
    chainId: 4663,
    to: router,
    data: swapData as `0x${string}`,
    value: "0",
    tokenIn: { symbol: "USDG", address: usdg, decimals: 6 },
    tokenOut: { symbol: "NVDA", address: nvda, decimals: 18 },
    amountIn: "25000000",
    amountOut: "120000000000000000",
    minAmountOut: "119402985074626865",
    requestId: "buy-quote-1",
    routing: "CLASSIC",
    protocols: ["V4"],
  };
  const order = { ticker: "NVDA", amountIn: "25000000", swapper: owner, slippageBps: 50 };

  const post = (body: unknown, contentType = "application/json") => ({
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

  it("returns the swap for the wallet to send", async () => {
    const swapFn = vi.fn(async () => swap);

    const res = await app({ swaps: { swap: swapFn } }).request("/swap", post(order));

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(swap);
    expect(swapFn).toHaveBeenCalledWith({ ...order, client: "perkos-api" });
  });

  it.each([
    ["an array body", [order], "invalid_request"],
    ["null", null, "invalid_request"],
    ["an unknown field", { ...order, recipient: owner }, "invalid_request"],
    ["a missing ticker", { ...order, ticker: undefined }, "invalid_ticker"],
    ["a numeric ticker", { ...order, ticker: 7 }, "invalid_ticker"],
    ["a numeric amount", { ...order, amountIn: 25000000 }, "invalid_amount"],
    ["a zero amount", { ...order, amountIn: "0" }, "invalid_amount"],
    ["a fractional amount", { ...order, amountIn: "1.5" }, "invalid_amount"],
    ["an exponent", { ...order, amountIn: "1e6" }, "invalid_amount"],
    ["a leading zero", { ...order, amountIn: "025000000" }, "invalid_amount"],
    ["a short swapper", { ...order, swapper: "0x1234" }, "invalid_swapper"],
    ["an ENS name", { ...order, swapper: "owner.eth" }, "invalid_swapper"],
    ["zero slippage", { ...order, slippageBps: 0 }, "invalid_slippage"],
    ["slippage over 500", { ...order, slippageBps: 501 }, "invalid_slippage"],
    ["fractional slippage", { ...order, slippageBps: 1.5 }, "invalid_slippage"],
    ["slippage as a string", { ...order, slippageBps: "50" }, "invalid_slippage"],
  ])("refuses %s with 400", async (_label, body, error) => {
    const swapFn = vi.fn(async () => swap);

    const res = await app({ swaps: { swap: swapFn } }).request("/swap", post(body));

    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error, message: expect.any(String) });
    expect(swapFn).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", post('{"ticker":')],
    ["a body that is not JSON", post("ticker=NVDA", "text/plain")],
    ["JSON sent as another type", post(order, "text/plain")],
    // A valid order padded past the limit: only the size can refuse it.
    ["a body over 128 KB", post(JSON.stringify(order) + " ".repeat(130 * 1024))],
  ])("refuses %s with 400", async (_label, init) => {
    const swapFn = vi.fn(async () => swap);

    const res = await app({ swaps: { swap: swapFn } }).request("/swap", init);

    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "invalid_request", message: expect.any(String) });
    expect(swapFn).not.toHaveBeenCalled();
  });

  it("refuses an order over the per-order cap", async () => {
    const res = await real({ EQLTY_AGENT_SWAP_MAX_AMOUNT: "5000000" }).request(
      "/swap",
      post({ ...order, amountIn: "5000001" }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "amount_above_limit",
      message: "amountIn is above this server's limit of 5000000 atomic USDG per swap",
    });
  });

  it("answers a missing Permit2 allowance with exactly what to set on chain", async () => {
    const message = "The swapper has no Permit2 allowance for the Universal Router yet.";
    const swapFn = async () => {
      throw new SwapError(409, "permit2_allowance_required", message, {
        allowance: { token: usdg, spender: router, amount: "25000000" },
      });
    };

    const res = await app({ swaps: { swap: swapFn } }).request("/swap", post(order));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "permit2_allowance_required",
      message,
      token: usdg,
      spender: router,
      amount: "25000000",
    });
  });

  it.each([
    [400, "invalid_swapper", "swapper cannot be the zero address"],
    [404, "not_uniswap_routable", "NVDA is not marked Uniswap routable in the stock catalog"],
    [404, "asset_not_found", "ZZZZ is not a Robinhood stock token on chain 4663"],
    [502, "uniswap_swap_failed", `Uniswap returned a transaction for ${owner}, not the configured Universal Router ${router}`],
    [503, "swap_unavailable", "Uniswap swaps are not configured on this server"],
  ] as const)("answers a %i %s refusal with its message", async (status, code, message) => {
    const swapFn = async () => {
      throw new SwapError(status, code, message);
    };

    const res = await app({ swaps: { swap: swapFn } }).request("/swap", post(order));

    expect(res.status).toBe(status);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: code, message });
  });

  it("tells a rate-limited caller when to retry", async () => {
    const swapFn = async () => {
      throw new SwapError(429, "rate_limited", "Too many swaps on this server; retry in 20 seconds", {
        retryAfterSeconds: 20,
      });
    };

    const res = await app({ swaps: { swap: swapFn } }).request("/swap", post(order));

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("20");
    expect(await res.json()).toEqual({
      error: "rate_limited",
      message: "Too many swaps on this server; retry in 20 seconds",
    });
  });

  it("keeps an unexpected failure public-safe", async () => {
    const swapFn = async () => {
      throw new Error('request body: {"x-api-key":"secret"}');
    };

    const res = await app({ swaps: { swap: swapFn } }).request("/swap", post(order));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "uniswap_swap_failed",
      message: "The external provider rejected the request.",
    });
  });
});

describe("the routes over the real services", () => {
  const key = "test-key-never-returned";
  const env = { UNISWAP_API_KEY: key, ROBINHOOD_RPC_URL: "https://rpc.example.test" };
  const post = (body: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const order = { ticker: "NVDA", amountIn: "1000000", swapper: owner, slippageBps: 50 };

  /** Uniswap and the RPC, answering like the real ones. */
  function upstream(over: { permit?: boolean; swapTo?: string } = {}) {
    return vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (target.startsWith("https://rpc.example.test")) {
        const result = sent.method === "eth_chainId" ? "0x1237" : `0x${(18).toString(16).padStart(64, "0")}`;
        return json({ jsonrpc: "2.0", id: sent.id, result });
      }
      if (target.endsWith("/quote")) {
        const swapper = String(sent.swapper);
        return json(
          {
            routing: "CLASSIC",
            quote: {
              swapper,
              chainId: 4663,
              input: { token: usdg, amount: sent.amount },
              output: { token: nvda, amount: "4800000000000000", recipient: swapper },
              aggregatedOutputs: [
                { token: nvda, amount: "4800000000000000", recipient: swapper, minAmount: "4776119402985074" },
              ],
              priceImpact: 0.42,
            },
            permitData: over.permit
              ? {
                  domain: { name: "Permit2", chainId: 4663, verifyingContract: permit2 },
                  values: {
                    details: { token: usdg, amount: sent.amount, expiration: "1780000000", nonce: "7" },
                    spender: router,
                    sigDeadline: "1780000000",
                  },
                }
              : null,
          },
          { "x-request-id": "req-1" },
        );
      }
      if (target.endsWith("/swap")) {
        return json({ swap: { to: over.swapTo ?? router, from: owner, data: swapData, value: "0x00", chainId: 4663 } });
      }
      return new Response("not found", { status: 404 });
    });
  }

  const tradingCalls = (http: ReturnType<typeof upstream>) =>
    http.mock.calls.filter(([url]) => String(url).startsWith("https://trade-api.gateway.uniswap.org/v1/"));

  it("quotes with the stand-in swapper, every Trading API call carrying the key and X-Agent-Info", async () => {
    const http = upstream();

    const res = await real(env, http).request("/quote?ticker=NVDA&amountIn=1000000");
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      ticker: "NVDA",
      amountOut: "4800000000000000",
      tokenOut: { decimals: 18 },
      requestId: "req-1",
      attribution: { decisionOrigin: "autonomous", status: null },
    });
    expect(text).not.toContain(key);
    const calls = tradingCalls(http);
    expect(calls).toHaveLength(1);
    for (const [, init] of calls) {
      expect(init?.headers).toMatchObject({
        "x-api-key": key,
        "x-universal-router-version": "2.1.1",
        "x-agent-info": '{"decision_origin":"autonomous","integration_name":"eqlty"}',
      });
    }
  });

  it("builds a swap for the wallet, every Trading API call human_mediated", async () => {
    const http = upstream();

    const res = await real(env, http).request("/swap", post(order));
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ chainId: 4663, to: router, data: swapData, value: "0" });
    expect(text).not.toContain(key);
    const calls = tradingCalls(http);
    expect(calls.map(([url]) => String(url).split("/").pop())).toEqual(["quote", "swap"]);
    for (const [, init] of calls) {
      expect(init?.headers).toMatchObject({
        "x-api-key": key,
        "x-agent-info": '{"decision_origin":"human_mediated","integration_name":"eqlty"}',
      });
    }
  });

  it("answers a permit with the allowance only: no permit data, nonce, deadline or signature", async () => {
    const res = await real(env, upstream({ permit: true })).request("/swap", post(order));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(409);
    expect(Object.keys(body).sort()).toEqual(["amount", "error", "message", "spender", "token"]);
    expect(body).toMatchObject({ error: "permit2_allowance_required", token: usdg, spender: router, amount: "1000000" });
    expect(JSON.stringify(body)).not.toMatch(/nonce|sigDeadline|signature|permitData/);
  });

  it("returns no calldata when Uniswap names another router", async () => {
    const res = await real(env, upstream({ swapTo: "0x204FAca1764B154221e35c0d20aBb3c525710498" })).request(
      "/swap",
      post(order),
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(502);
    expect(body.error).toBe("uniswap_swap_failed");
    expect(body).not.toHaveProperty("data");
  });

  it("answers 503 without a key, and asks nobody", async () => {
    const http = upstream();
    const keyless = real({}, http);

    const quote = await keyless.request("/quote?ticker=NVDA&amountIn=1000000");
    expect(quote.status).toBe(503);
    expect(await quote.json()).toMatchObject({ error: "quote_unavailable" });

    const swap = await keyless.request("/swap", post(order));
    expect(swap.status).toBe(503);
    expect(await swap.json()).toMatchObject({ error: "swap_unavailable" });
    expect(http).not.toHaveBeenCalled();
  });
});

describe("the trading configuration", () => {
  it("defaults to the public endpoints and a 100 USDG cap, with no key", () => {
    expect(loadTradingConfig({})).toEqual({
      uniswapApiKey: null,
      uniswapApiUrl: "https://trade-api.gateway.uniswap.org/v1",
      robinhoodRpcUrl: "https://rpc.mainnet.chain.robinhood.com",
      quoteSwapper: "0x000000000000000000000000000000000000dEaD",
      quoteMaxAmount: 100_000_000n,
      swapMaxAmount: 100_000_000n,
    });
  });

  it("treats an empty value as unset, as compose passes one", () => {
    const config = loadTradingConfig({ UNISWAP_API_KEY: " ", UNISWAP_API_URL: "", EQLTY_AGENT_SWAP_MAX_AMOUNT: "" });
    expect(config.uniswapApiKey).toBeNull();
    expect(config.uniswapApiUrl).toBe("https://trade-api.gateway.uniswap.org/v1");
    expect(config.swapMaxAmount).toBe(100_000_000n);
  });

  it.each([
    ["EQLTY_AGENT_SWAP_MAX_AMOUNT", "100 USDG"],
    ["EQLTY_AGENT_QUOTE_MAX_AMOUNT", "0"],
    ["UNISWAP_API_URL", "trade-api"],
    ["ROBINHOOD_RPC_URL", "ftp://rpc.example"],
    ["UNISWAP_QUOTE_SWAPPER", "0x1234"],
  ])("stops at boot on a malformed %s", (name, value) => {
    expect(() => loadTradingConfig({ [name]: value })).toThrow(name);
  });

  it.each([["a line break", "sk-part1\nsk-part2"], ["a space", "sk part"], ["a NUL", "sk\u0000x"]])(
    "stops at boot on a key with %s, without repeating it",
    (_label, key) => {
      let message = "";
      try {
        loadTradingConfig({ UNISWAP_API_KEY: key });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toBe("UNISWAP_API_KEY must be plain visible ASCII");
    },
  );

  it("answers JSON for a path the desk does not serve", async () => {
    const res = await app({}).request("/nothing-here");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } });
}
