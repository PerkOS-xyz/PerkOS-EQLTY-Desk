import { describe, expect, it, vi } from "vitest";

import { activityFromEnv, deepestPools, PoolActivity } from "../src/activity.ts";
import { EqltyMarket } from "../src/market.ts";

const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const AMZN = "0x12f190a9F9d7D37a250758b26824B97CE941bF54";

const pair = (address: string, liquidity: number, h24: number, volume: number, chainId = "robinhood") => ({
  chainId,
  baseToken: { address },
  priceChange: { h24 },
  volume: { h24: volume },
  liquidity: { usd: liquidity },
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("deepestPools", () => {
  it("keeps the deepest Robinhood Chain pool of each token asked about", () => {
    const found = deepestPools(
      [pair(NVDA, 100, 1.5, 10), pair(NVDA, 5_000_000, -0.92, 16_480_570), pair(NVDA, 9e9, 50, 1, "base"), pair(AMZN, 10, 2, 3)],
      new Set([NVDA.toLowerCase()]),
    );
    expect(found.get(NVDA.toLowerCase())).toEqual({ change24hPct: -0.92, volume24hUsd: 16_480_570 });
    expect(found.has(AMZN.toLowerCase())).toBe(false);
  });
});

describe("PoolActivity", () => {
  it("reads in batches of 30 and remembers the answer for a while", async () => {
    let now = 1_000;
    const http = vi.fn(async (url: string | URL | Request) => {
      const addresses = String(url).split("/tokens/v1/robinhood/")[1]!.split(",");
      return json(addresses.map((a, i) => pair(a, 10 + i, i, i * 100)));
    });
    const activity = new PoolActivity({ fetchImpl: http as unknown as typeof fetch, now: () => now });
    const addresses = Array.from({ length: 65 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`);
    const first = await activity.forAddresses(addresses);
    expect(http).toHaveBeenCalledTimes(3);
    expect(String(http.mock.calls[0]![0])).toMatch(/^https:\/\/api\.dexscreener\.com\/tokens\/v1\/robinhood\/0x/);
    expect(first.size).toBe(65);
    now += 60_000;
    await activity.forAddresses(addresses);
    expect(http).toHaveBeenCalledTimes(3);
    now += 120_001;
    await activity.forAddresses(addresses);
    expect(http).toHaveBeenCalledTimes(6);
  });

  it("answers without waiting long for a slow index, and fills in later", async () => {
    let release: (r: Response) => void = () => {};
    const http = vi.fn(() => new Promise<Response>((resolve) => (release = resolve)));
    const activity = new PoolActivity({ fetchImpl: http as unknown as typeof fetch, waitMs: 10 });
    expect((await activity.forAddresses([NVDA])).size).toBe(0);
    release(json([pair(NVDA, 1, 3.3, 44)]));
    await new Promise((r) => setTimeout(r, 0));
    expect((await activity.forAddresses([NVDA])).get(NVDA.toLowerCase())).toEqual({ change24hPct: 3.3, volume24hUsd: 44 });
  });

  it("keeps what it knew when a later read fails", async () => {
    let now = 0;
    let fail = false;
    const http = vi.fn(async () => (fail ? json({ error: "busy" }, 429) : json([pair(NVDA, 1, 1, 2)])));
    const activity = new PoolActivity({ fetchImpl: http as unknown as typeof fetch, now: () => now });
    await activity.forAddresses([NVDA]);
    fail = true;
    now += 200_000;
    expect((await activity.forAddresses([NVDA])).get(NVDA.toLowerCase())).toEqual({ change24hPct: 1, volume24hUsd: 2 });
  });

  it("can be turned off", () => {
    expect(activityFromEnv({ DESK_ACTIVITY: "off" })).toBeNull();
    expect(activityFromEnv({})).toBeInstanceOf(PoolActivity);
  });
});

describe("the desk market with activity", () => {
  const catalogue = json({
    chainId: 4663,
    quoteToken: { symbol: "USDG" },
    observedAt: "2026-09-26T09:00:00.000Z",
    assets: [
      { ticker: "NVDA", name: "NVIDIA", tokenAddress: NVDA, decimals: 18, referencePrice: 225.1, uniswapRoutable: true },
      { ticker: "AMZN", name: "Amazon", tokenAddress: AMZN, decimals: 18, referencePrice: 252.4, uniswapRoutable: true, priceChange24hPct: 0.5, volume24hUsd: 7 },
    ],
  });

  it("fills the 24h change and volume the catalogue left empty, and keeps the ones it gave", async () => {
    const activity = { forAddresses: vi.fn(async () => new Map([[NVDA.toLowerCase(), { change24hPct: -0.92, volume24hUsd: 16_480_570 }], [AMZN.toLowerCase(), { change24hPct: 9, volume24hUsd: 9 }]])) };
    const market = new EqltyMarket({ baseUrl: "https://eqlty.test", fetchImpl: (async () => catalogue.clone()) as typeof fetch, activity });
    const out = await market.market();
    expect(out.assets.find((a) => a.ticker === "NVDA")).toMatchObject({ change24hPct: -0.92, volume24hUsd: 16_480_570 });
    expect(out.assets.find((a) => a.ticker === "AMZN")).toMatchObject({ change24hPct: 0.5, volume24hUsd: 7 });
    expect(activity.forAddresses).toHaveBeenCalledWith([NVDA]);
  });

  it("still answers when the activity read throws", async () => {
    const activity = { forAddresses: vi.fn(async () => { throw new Error("down"); }) };
    const market = new EqltyMarket({ baseUrl: "https://eqlty.test", fetchImpl: (async () => catalogue.clone()) as typeof fetch, activity });
    const out = await market.market();
    expect(out.assets.find((a) => a.ticker === "NVDA")).toMatchObject({ change24hPct: null, volume24hUsd: null });
  });
});
