/**
 * The Trading API client against the shapes the API really returns, over a
 * fake fetch. What is worth pinning down: every call carries the key, the
 * router version and X-Agent-Info; a permit is answered with an allowance,
 * never a signature; and a built swap for any other router, sender, value or
 * chain is refused before its calldata can leave.
 */

import { describe, expect, it, vi } from "vitest";

import { UniswapClient, type UniswapSource } from "../src/uniswap-client.ts";

const usdg = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const nvda = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const router = "0x8876789976decbfcbbbe364623c63652db8c0904";
const permit2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const standIn = "0x000000000000000000000000000000000000dEaD";
const other = "0x9999999999999999999999999999999999999999";
const owner = "0x1234567890abcdef1234567890abcdef12345678";
const swapData = `0x3593564c${"00".repeat(32)}` as const;
const apiUrl = "https://trade-api.gateway.uniswap.org/v1";
const autonomousHeader = '{"decision_origin":"autonomous","integration_name":"eqlty"}';
const humanHeader = '{"decision_origin":"human_mediated","integration_name":"eqlty"}';

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

const client = (http: FetchMock, over: Partial<UniswapSource> = {}) =>
  new UniswapClient({ apiKey: "test-key", apiUrl, quoteSwapper: standIn, fetchImpl: http, wait: async () => {}, ...over });

describe("Uniswap quotes", () => {
  it("returns the quote details and names the stand-in swapper", async () => {
    const body = quoteBody({ swapper: standIn });
    const route = [[{ type: "v4-pool", address: other, fee: "3000" }]];
    Object.assign(body.quote, { priceImpact: 0.42, route, gasFeeUSD: "0.0031" });
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(body, { "x-request-id": "quote-agent-1" }));

    const quote = await client(http).quote(nvda, "1000000", "autonomous");

    expect(quote).toEqual({
      amountOut: "4800000000000000",
      requestId: "quote-agent-1",
      routing: "CLASSIC",
      priceImpactPct: 0.42,
      route,
      gasFeeUsd: "0.0031",
      reportedRouting: "CLASSIC",
      attribution: { decisionOrigin: "autonomous", status: null },
    });
    expect(http.mock.calls[0]?.[0]).toBe(`${apiUrl}/quote`);
    expect(sentBody(http, 0)).toEqual({
      tokenIn: usdg,
      tokenOut: nvda,
      amount: "1000000",
      type: "EXACT_INPUT",
      swapper: standIn,
      tokenInChainId: 4663,
      tokenOutChainId: 4663,
      slippageTolerance: 1,
      routingPreference: "BEST_PRICE",
      protocols: ["V4"],
      hooksOptions: "V4_NO_HOOKS",
      permitAmount: "EXACT",
    });
  });

  it("sends the key, the router version and X-Agent-Info", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(quoteBody(), { "x-request-id": "q" }));

    await client(http).quote(nvda, "1000000", "autonomous");

    expect(sentHeaders(http, 0)).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": "test-key",
      "x-universal-router-version": "2.1.1",
      "x-agent-info": autonomousHeader,
    });
  });

  it("carries the caller's origin and surfaces the gateway status", async () => {
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(quoteBody(), { "x-request-id": "q", "x-agent-info-status": "malformed" }));

    const quote = await client(http).quote(nvda, "1000000", "human_mediated");

    expect(sentHeaders(http, 0)["x-agent-info"]).toBe(humanHeader);
    expect(quote.attribution).toEqual({ decisionOrigin: "human_mediated", status: "malformed" });
  });

  it("leaves out what the Trading API did not send", async () => {
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ quote: { output: { amount: "7" } }, requestId: "from-body" }));

    const quote = await client(http).quote(nvda, "1000000", "autonomous");

    expect(quote).toMatchObject({ amountOut: "7", requestId: "from-body", routing: "V4" });
    expect(quote.reportedRouting).toBeUndefined();
    expect(quote.priceImpactPct).toBeUndefined();
  });

  it("waits and asks again after a 429, then gives up after three", async () => {
    const limited = () => new Response("{}", { status: 429, headers: { "retry-after": "2" } });
    const wait = vi.fn(async () => {});
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(limited())
      .mockResolvedValueOnce(jsonResponse(quoteBody(), { "x-request-id": "q" }));

    await expect(client(http, { wait }).quote(nvda, "1000000", "autonomous")).resolves.toMatchObject({
      requestId: "q",
    });
    expect(wait).toHaveBeenCalledWith(2_000);

    const always = vi.fn<typeof fetch>(async () => limited());
    await expect(client(always).quote(nvda, "1000000", "autonomous")).rejects.toThrow(
      "Uniswap quote failed with status 429",
    );
    expect(always).toHaveBeenCalledTimes(3);
  });

  it("reports a failed quote with its status, and a quote with no output", async () => {
    const failed = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ errorCode: "x" }, {}, 500));
    await expect(client(failed).quote(nvda, "1000000", "autonomous")).rejects.toThrow(
      "Uniswap quote failed with status 500",
    );

    const empty = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ quote: {} }));
    await expect(client(empty).quote(nvda, "1000000", "autonomous")).rejects.toThrow(
      "Uniswap quote returned no output amount",
    );
  });

  it("asks nothing without a key", async () => {
    const http = vi.fn<typeof fetch>();
    const keyless = client(http, { apiKey: null });

    expect(keyless.ready()).toBe(false);
    expect(keyless.walletSwapReady()).toBe(false);
    await expect(keyless.quote(nvda, "1000000", "autonomous")).rejects.toThrow("not configured");
    expect(http).not.toHaveBeenCalled();
  });
});

describe("Uniswap wallet buys", () => {
  const buy = { tokenOut: nvda, amount: "1000000", swapper: owner, maxSlippageBps: 50 } as const;

  it("builds a swap for the wallet to send and signs nothing", async () => {
    const quote = walletBuyQuote();
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(quote, { "x-request-id": "buy-quote-1" }))
      .mockResolvedValueOnce(jsonResponse(swapResponse()));

    const built = await client(http).prepareWalletBuy({ ...buy, decisionOrigin: "human_mediated" });

    expect(built).toEqual({
      amountOut: "4800000000000000",
      minAmountOut: "4776119402985074",
      requestId: "buy-quote-1",
      routing: "CLASSIC",
      transaction: { to: router, from: owner, data: swapData, value: "0x00", chainId: 4663 },
      attribution: { decisionOrigin: "human_mediated", status: null },
    });
    expect(http).toHaveBeenCalledTimes(2);
    expect(http.mock.calls[0]?.[0]).toBe(`${apiUrl}/quote`);
    expect(sentBody(http, 0)).toMatchObject({
      tokenIn: usdg,
      tokenOut: nvda,
      amount: "1000000",
      type: "EXACT_INPUT",
      swapper: owner,
      tokenInChainId: 4663,
      tokenOutChainId: 4663,
      slippageTolerance: 0.5,
      protocols: ["V4"],
    });
    expect(http.mock.calls[1]?.[0]).toBe(`${apiUrl}/swap`);
    expect(sentBody(http, 1)).toEqual({ quote: quote.quote, simulateTransaction: true });
    for (const call of [0, 1]) {
      expect(sentHeaders(http, call)).toMatchObject({
        "x-api-key": "test-key",
        "x-universal-router-version": "2.1.1",
        "x-agent-info": humanHeader,
      });
    }
  });

  it("keeps the gateway status from either call", async () => {
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(walletBuyQuote(), { "x-request-id": "buy-quote-1" }))
      .mockResolvedValueOnce(jsonResponse(swapResponse(), { "x-agent-info-status": "malformed" }));

    const built = await client(http).prepareWalletBuy({ ...buy, decisionOrigin: "human_mediated" });

    expect(built.attribution).toEqual({ decisionOrigin: "human_mediated", status: "malformed" });
  });

  it("asks for an on-chain Permit2 allowance instead of signing the permit", async () => {
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ ...walletBuyQuote(), permitData: quoteBody().permitData }, { "x-request-id": "buy-quote-2" }),
      );

    await expect(client(http).prepareWalletBuy({ ...buy, decisionOrigin: "human_mediated" })).rejects.toMatchObject({
      name: "Permit2AllowanceRequiredError",
      token: usdg,
      spender: router,
      amount: "1000000",
      permit2,
    });
    expect(http).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "a spender other than the router",
      (p: PermitData) => void (p.values.spender = other),
      "Permit2 spender is not the authorized router",
    ],
    [
      "another verifying contract",
      (p: PermitData) => void (p.domain.verifyingContract = other),
      "Permit2 domain is not canonical",
    ],
    ["another chain", (p: PermitData) => void (p.domain.chainId = 1), "Permit2 domain is not canonical"],
    ["another amount", (p: PermitData) => void (p.values.details.amount = "2000000"), "Permit2 amount is not exact"],
  ])("refuses a permit with %s", async (_label, change, message) => {
    const permitData = quoteBody().permitData;
    change(permitData);
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...walletBuyQuote(), permitData }, { "x-request-id": "buy-quote-3" }));

    await expect(client(http).prepareWalletBuy({ ...buy, decisionOrigin: "human_mediated" })).rejects.toThrow(message);
  });

  it("refuses a transaction for any contract but the configured router", async () => {
    const elsewhere = "0x204FAca1764B154221e35c0d20aBb3c525710498";
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(walletBuyQuote(), { "x-request-id": "buy-quote-4" }))
      .mockResolvedValueOnce(jsonResponse(swapResponse({ to: elsewhere })));

    await expect(client(http).prepareWalletBuy({ ...buy, decisionOrigin: "human_mediated" })).rejects.toThrow(
      `Uniswap returned a transaction for ${elsewhere}, not the configured Universal Router ${router}`,
    );
  });

  it.each([
    ["a sender other than the wallet", { from: other }, "Uniswap transaction sender is not the requested wallet"],
    ["native value", { value: "1" }, "A USDG purchase cannot include native value"],
    ["another chain", { chainId: 1 }, "Uniswap transaction is not on Robinhood Chain"],
    ["no calldata", { data: "0x" }, "Uniswap transaction has no calldata"],
  ])("refuses a transaction with %s", async (_label, change, message) => {
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(walletBuyQuote(), { "x-request-id": "buy-quote-5" }))
      .mockResolvedValueOnce(jsonResponse(swapResponse(change)));

    await expect(client(http).prepareWalletBuy({ ...buy, decisionOrigin: "human_mediated" })).rejects.toThrow(message);
  });

  it.each([
    [
      "a routing other than CLASSIC",
      (b: WalletBuyQuote) => void (b.routing = "DUTCH_V2"),
      "Uniswap quote routing is not CLASSIC",
    ],
    [
      "a quote for another swapper",
      (b: WalletBuyQuote) => void (b.quote.swapper = other),
      "Uniswap quote swapper is not the requested wallet",
    ],
    [
      "another input amount",
      (b: WalletBuyQuote) => void (b.quote.input.amount = "2000000"),
      "Uniswap quote input does not match the order",
    ],
    [
      "output sent elsewhere",
      (b: WalletBuyQuote) => void (b.quote.output.recipient = other),
      "Uniswap quote output does not return to the wallet",
    ],
    [
      "another chain",
      (b: WalletBuyQuote) => void (b.quote.tokenOutChainId = 1),
      "Uniswap quote is not on Robinhood Chain",
    ],
    [
      "no aggregated output for the wallet",
      (b: WalletBuyQuote) => void delete b.quote.aggregatedOutputs,
      "Uniswap quote has no single output for the wallet",
    ],
    [
      "no minimum output",
      (b: WalletBuyQuote) => void delete b.quote.aggregatedOutputs?.[0]?.minAmount,
      "Uniswap quote returned no minimum output for the wallet",
    ],
    [
      "a minimum below the requested slippage",
      (b: WalletBuyQuote) => void (b.quote.aggregatedOutputs![0]!.minAmount = "4775999999999999"),
      "Uniswap minimum output does not match the requested slippage",
    ],
  ])("refuses %s before building", async (_label, change, message) => {
    const body = walletBuyQuote();
    change(body);
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(body, { "x-request-id": "buy-quote-6" }));

    await expect(client(http).prepareWalletBuy({ ...buy, decisionOrigin: "human_mediated" })).rejects.toThrow(message);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("refuses a quote with no request identifier", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(walletBuyQuote()));

    await expect(client(http).prepareWalletBuy({ ...buy, decisionOrigin: "human_mediated" })).rejects.toThrow(
      "Uniswap quote returned no request identifier",
    );
  });

  it("reports a failed swap build with its status", async () => {
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(walletBuyQuote(), { "x-request-id": "buy-quote-7" }))
      .mockResolvedValueOnce(jsonResponse({ errorCode: "ValidationError" }, {}, 400));

    await expect(client(http).prepareWalletBuy({ ...buy, decisionOrigin: "human_mediated" })).rejects.toThrow(
      "Uniswap swap build failed with status 400",
    );
  });
});

type PermitData = ReturnType<typeof quoteBody>["permitData"];
type WalletBuyQuote = ReturnType<typeof walletBuyQuote>;

function quoteBody(over: { swapper?: string } = {}) {
  const swapper = over.swapper ?? owner;
  return {
    routing: "CLASSIC",
    quote: {
      swapper,
      chainId: 4663,
      tokenInChainId: 4663,
      tokenOutChainId: 4663,
      input: { token: usdg, amount: "1000000" },
      output: { token: nvda, amount: "4800000000000000", recipient: swapper },
    } as Record<string, unknown> & {
      swapper: string;
      tokenOutChainId: number;
      input: { token: string; amount: string };
      output: { token: string; amount: string; recipient: string };
    },
    permitData: {
      domain: { name: "Permit2", chainId: 4663, verifyingContract: permit2 },
      types: {
        PermitDetails: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint160" },
          { name: "expiration", type: "uint48" },
          { name: "nonce", type: "uint48" },
        ],
        PermitSingle: [
          { name: "details", type: "PermitDetails" },
          { name: "spender", type: "address" },
          { name: "sigDeadline", type: "uint256" },
        ],
      },
      values: {
        details: { token: usdg, amount: "1000000", expiration: "1780000000", nonce: "0" },
        spender: router,
        sigDeadline: "1780000000",
      },
    },
  };
}

// A CLASSIC quote with no permit, shaped like the Trading API reference: the
// wallet's own output carries the minimum in aggregatedOutputs.
function walletBuyQuote() {
  const body = quoteBody({ swapper: owner });
  return {
    routing: body.routing,
    quote: {
      ...body.quote,
      aggregatedOutputs: [
        { token: nvda, amount: "4800000000000000", recipient: owner, bps: 10_000, minAmount: "4776119402985074" },
      ] as Array<Record<string, unknown>> | undefined,
    },
    permitData: null as unknown,
  };
}

function swapResponse(change: Record<string, unknown> = {}) {
  return {
    requestId: "buy-swap-1",
    swap: { to: router, from: owner, data: swapData, value: "0x00", chainId: 4663, ...change },
  };
}

function sentHeaders(http: FetchMock, call: number): Record<string, string> {
  return http.mock.calls[call]?.[1]?.headers as Record<string, string>;
}

function sentBody(http: FetchMock, call: number): Record<string, unknown> {
  return JSON.parse(String(http.mock.calls[call]?.[1]?.body)) as Record<string, unknown>;
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
