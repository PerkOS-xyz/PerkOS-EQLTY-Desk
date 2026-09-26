/**
 * The swap the person's wallet sends. What matters: it is built for that
 * wallet and nobody else, a missing allowance comes back as the allowance to
 * set (never a permit), refusals happen before anything is spent, and a
 * ticker that cannot be routed costs no budget.
 */

import { describe, expect, it, vi } from "vitest";

import { SwapService } from "../src/swap.ts";
import type { StockToken } from "../src/tokens.ts";
import { Permit2AllowanceRequiredError, type WalletBuySwap } from "../src/uniswap-client.ts";

const usdg = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const nvda = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const router = "0x8876789976decbfcbbbe364623c63652db8c0904";
const permit2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const other = "0x9999999999999999999999999999999999999999";
const owner = "0x1234567890abcdef1234567890abcdef12345678";
const swapData = `0x3593564c${"00".repeat(32)}` as const;
const start = Date.parse("2026-09-26T12:00:00.000Z");

const order = { ticker: "NVDA", amountIn: "25000000", swapper: owner, slippageBps: 50 } as const;

describe("swap", () => {
  it("builds the swap for the person's wallet as human_mediated", async () => {
    const { service, uniswap, decimals } = setup();

    const swap = await service.swap({ ...order, ticker: "nvda" });

    expect(swap).toEqual({
      chainId: 4663,
      to: router,
      data: swapData,
      value: "0",
      tokenIn: { symbol: "USDG", address: usdg, decimals: 6 },
      tokenOut: { symbol: "NVDA", address: nvda, decimals: 18 },
      amountIn: "25000000",
      amountOut: "120000000000000000",
      minAmountOut: "119402985074626865",
      requestId: "buy-quote-1",
      routing: "CLASSIC",
      protocols: ["V4"],
    });
    expect(uniswap.prepareWalletBuy).toHaveBeenCalledWith({
      tokenOut: nvda,
      amount: "25000000",
      swapper: owner,
      maxSlippageBps: 50,
      decisionOrigin: "human_mediated",
    });
    expect(decimals.decimals).toHaveBeenCalledWith(nvda);
  });

  it("asks every time, because a quote belongs to its swapper", async () => {
    const { service, uniswap } = setup();

    await service.swap(order);
    await service.swap(order);

    expect(uniswap.prepareWalletBuy).toHaveBeenCalledTimes(2);
  });

  it("answers a permit with the allowance to set on chain", async () => {
    const { service } = setup({
      prepareWalletBuy: async () => {
        throw new Permit2AllowanceRequiredError(usdg, router, "25000000", permit2);
      },
    });

    await expect(service.swap(order)).rejects.toMatchObject({
      status: 409,
      code: "permit2_allowance_required",
      message: expect.stringContaining(`Permit2 (${permit2})`),
      extra: { allowance: { token: usdg, spender: router, amount: "25000000" } },
    });
  });

  it("reports a refused router as a public-safe 502", async () => {
    const refusal = `Uniswap returned a transaction for ${other}, not the configured Universal Router ${router}`;
    const { service } = setup({
      prepareWalletBuy: async () => {
        throw new Error(refusal);
      },
    });

    await expect(service.swap(order)).rejects.toMatchObject({
      status: 502,
      code: "uniswap_swap_failed",
      message: refusal,
    });
  });

  it("keeps an upstream failure public-safe", async () => {
    const { service } = setup({
      prepareWalletBuy: async () => {
        throw new Error("request body: https://trade-api.gateway.uniswap.org/v1");
      },
    });

    await expect(service.swap(order)).rejects.toMatchObject({
      status: 502,
      code: "uniswap_swap_failed",
      message: "The external provider rejected the request.",
    });
  });

  it("refuses an amount over the per-order cap before asking anyone", async () => {
    const { service, tokens, uniswap } = setup();

    await expect(service.swap({ ...order, amountIn: "100000001" })).rejects.toMatchObject({
      status: 400,
      code: "amount_above_limit",
      message: "amountIn is above this server's limit of 100000000 atomic USDG per swap",
    });
    expect(tokens.find).not.toHaveBeenCalled();
    expect(uniswap.prepareWalletBuy).not.toHaveBeenCalled();
  });

  it("uses the cap it was given", async () => {
    const { service } = setup({ maxAmount: 5_000_000n });

    await expect(service.swap({ ...order, amountIn: "5000000" })).resolves.toMatchObject({ amountIn: "5000000" });
    await expect(service.swap({ ...order, amountIn: "5000001" })).rejects.toMatchObject({
      status: 400,
      code: "amount_above_limit",
    });
  });

  it("refuses the zero address as the swapper", async () => {
    const { service, uniswap } = setup();

    await expect(
      service.swap({ ...order, swapper: "0x0000000000000000000000000000000000000000" }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_swapper" });
    expect(uniswap.prepareWalletBuy).not.toHaveBeenCalled();
  });

  it("refuses a token the market does not mark tradeable", async () => {
    const { service, uniswap } = setup({ find: async () => token({ tradeable: false }) });

    await expect(service.swap(order)).rejects.toMatchObject({
      status: 404,
      code: "not_uniswap_routable",
      message: "NVDA is not marked Uniswap routable in the stock catalog",
    });
    expect(uniswap.prepareWalletBuy).not.toHaveBeenCalled();
  });

  it("refuses a ticker that is not in the market", async () => {
    const { service } = setup({ find: async () => undefined });

    await expect(service.swap({ ...order, ticker: "ZZZZ" })).rejects.toMatchObject({
      status: 404,
      code: "asset_not_found",
    });
  });

  it("reports an unavailable market as a 502", async () => {
    const { service } = setup({
      find: async () => {
        throw new Error("The EQLTY market answered 503");
      },
    });

    await expect(service.swap(order)).rejects.toMatchObject({
      status: 502,
      code: "catalog_unavailable",
      message: "The EQLTY market answered 503",
    });
  });

  it("refuses to answer when the token decimals cannot be read", async () => {
    const { service } = setup({
      decimals: async () => {
        throw new Error("execution reverted");
      },
    });

    await expect(service.swap(order)).rejects.toMatchObject({ status: 502, code: "token_decimals_unavailable" });
  });

  it.each([
    ["the Trading API key", { walletSwapReady: () => false }],
    ["the decimals RPC", { decimalsReady: () => false }],
  ])("says so when %s is not configured", async (_label, over) => {
    const { service, tokens } = setup(over);

    await expect(service.swap(order)).rejects.toMatchObject({ status: 503, code: "swap_unavailable" });
    expect(tokens.find).not.toHaveBeenCalled();
  });

  it("gives each caller 12 swap builds a minute and spends none on a ticker it cannot route", async () => {
    let now = start;
    const { service, uniswap } = setup({
      now: () => now,
      find: async (ticker) => (ticker === "NVDA" ? token() : undefined),
    });
    const input = { ...order, client: "a" };
    // Junk tickers are refused before they touch the budget.
    for (let call = 0; call < 30; call += 1) {
      await expect(service.swap({ ...input, ticker: "NOPE" })).rejects.toMatchObject({ status: 404 });
    }
    for (let call = 0; call < 12; call += 1) {
      await service.swap(input);
    }

    now = start + 40_000;
    await expect(service.swap(input)).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      extra: { retryAfterSeconds: 20 },
    });
    // Another caller keeps its own share.
    await expect(service.swap({ ...input, client: "b" })).resolves.toMatchObject({ requestId: "buy-quote-1" });
    expect(uniswap.prepareWalletBuy).toHaveBeenCalledTimes(13);

    now = start + 60_000;
    await expect(service.swap(input)).resolves.toMatchObject({ requestId: "buy-quote-1" });
  });

  it("still caps the whole server at 60 swap builds a minute", async () => {
    const { service } = setup();
    for (let call = 0; call < 60; call += 1) {
      await service.swap({ ...order, client: `c${call % 6}` });
    }
    await expect(service.swap({ ...order, client: "fresh" })).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
    });
  });
});

function setup(
  over: {
    prepareWalletBuy?: () => Promise<WalletBuySwap>;
    walletSwapReady?: () => boolean;
    decimals?: () => Promise<number>;
    decimalsReady?: () => boolean;
    find?: (ticker: string) => Promise<StockToken | undefined>;
    maxAmount?: bigint;
    now?: () => number;
  } = {},
) {
  const tokens = { find: vi.fn(over.find ?? (async () => token())) };
  const uniswap = {
    walletSwapReady: over.walletSwapReady ?? (() => true),
    prepareWalletBuy: vi.fn(over.prepareWalletBuy ?? (async () => built())),
  };
  const decimals = {
    ready: over.decimalsReady ?? (() => true),
    decimals: vi.fn(over.decimals ?? (async () => 18)),
  };
  const service = new SwapService({
    maxAmount: over.maxAmount ?? 100_000_000n,
    tokens,
    uniswap,
    decimals,
    now: over.now ?? (() => start),
  });
  return { service, tokens, uniswap, decimals };
}

function built(): WalletBuySwap {
  return {
    amountOut: "120000000000000000",
    minAmountOut: "119402985074626865",
    requestId: "buy-quote-1",
    routing: "CLASSIC",
    transaction: { to: router, from: owner, data: swapData, value: "0x00", chainId: 4663 },
    attribution: { decisionOrigin: "human_mediated", status: null },
  };
}

function token(over: Partial<StockToken> = {}): StockToken {
  return { ticker: "NVDA", address: nvda, tradeable: true, ...over };
}
