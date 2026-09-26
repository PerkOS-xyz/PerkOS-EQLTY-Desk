/**
 * The desk over HTTP. The case that matters is the market being down: PerkOS
 * has to be able to tell "this desk cannot answer right now" from "this desk
 * trades nothing", and those look identical if a failure returns an empty list.
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/server.ts";
import { DeskUnavailableError } from "../src/market.ts";
import type { DeskManifest, DeskMarket, DeskSeries } from "../src/contract.ts";

const market: DeskMarket = {
  chain: "robinhood",
  chainId: 4663,
  quoteSymbol: "USDG",
  assets: [
    {
      ticker: "NVDA",
      name: "NVIDIA",
      address: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
      decimals: 18,
      priceUsd: 225.27,
      priceAt: "2026-09-24T01:42:52.448Z",
      change24hPct: -1.48,
      volume24hUsd: 1,
      tradeable: true,
      logoUrl: null,
    },
  ],
  observedAt: "2026-09-24T01:42:56.283Z",
};

const stub = (over: Partial<{ market: () => Promise<DeskMarket>; series: (t: string[]) => Promise<DeskSeries[]> }> = {}) =>
  ({
    market: over.market ?? (async () => market),
    series: over.series ?? (async () => []),
  }) as unknown as Parameters<typeof createApp>[0];

describe("the desk over HTTP", () => {
  it("says which contract it speaks", async () => {
    const res = await createApp(stub()).request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, desk: "eqlty", contract: "1" });
  });

  it("answers the market", async () => {
    const res = await createApp(stub()).request("/market");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ chain: "robinhood", quoteSymbol: "USDG" });
  });

  it("asks for tickers rather than guessing them", async () => {
    const res = await createApp(stub()).request("/series");
    expect(res.status).toBe(400);
  });

  it("says it cannot answer instead of answering with nothing", async () => {
    const down = stub({
      market: async () => {
        throw new DeskUnavailableError("The EQLTY market answered 503");
      },
    });
    const res = await createApp(down).request("/market");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "desk_unavailable", message: "The EQLTY market answered 503" });
  });

  it("describes itself and how its team works a turn, within the contract's limits", async () => {
    const res = await createApp(stub()).request("/manifest");
    expect(res.status).toBe(200);
    const m = (await res.json()) as DeskManifest;
    expect(m.tagline).toBe("Tokenized stocks on Robinhood Chain");
    expect(m.screens).toEqual(["market", "trader", "history"]);
    expect(Object.keys(m.turns).sort()).toEqual(["advise", "analyze"]);
    expect(m.starters.length).toBeLessThanOrEqual(6);
    expect(m.rules.length).toBeLessThanOrEqual(1600);
    for (const s of m.starters) expect(s.text.length <= 120 && s.tag.length <= 60).toBe(true);
    for (const roles of Object.values(m.turns)) {
      for (const prompt of Object.values(roles ?? {})) expect(prompt.length).toBeLessThanOrEqual(1200);
    }
    expect(m.rules).toContain("USDG");
  });

  it("says which turn each starter runs, its order ceiling and its venues", async () => {
    const res = await createApp(stub()).request("/manifest");
    const m = (await res.json()) as DeskManifest;
    expect(m.starters.map((s) => [s.text, s.turn ?? null])).toEqual([
      ["What should I buy this month?", "advise"],
      ["How is NVDA doing today?", "analyze"],
      ["What can I trade on this desk?", null],
      ["Is Apple cheaper than Microsoft right now?", "analyze"],
    ]);
    expect(m.maxOrder).toBe(100);
    expect(m.venues).toEqual(["Uniswap on Robinhood Chain"]);
  });
});
