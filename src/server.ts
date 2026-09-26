/**
 * The desk, over HTTP.
 *
 * PerkOS asks this service for the desk's market and proxies the answer to
 * whoever is drawing it: what can be traded, what it was worth, and how the
 * desk presents itself and runs its team. Reads only. Nothing here can spend,
 * sign, or reach a person's wallet.
 *
 * When the market underneath is down it answers 503 and says so, because a
 * desk that returns an empty list looks like a market with nothing in it.
 */

import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";

import { DESK_CONTRACT_VERSION } from "./contract.ts";
import { MANIFEST } from "./manifest.ts";
import { DeskUnavailableError, EqltyMarket } from "./market.ts";

const EQLTY_API_URL = process.env.EQLTY_API_URL?.trim() || "https://eqlty-api.perkos.xyz";
const PORT = Number(process.env.PORT ?? 8090);

export function createApp(market = new EqltyMarket({ baseUrl: EQLTY_API_URL })): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, desk: "eqlty", contract: DESK_CONTRACT_VERSION }));

  app.get("/manifest", (c) => c.json(MANIFEST));

  app.get("/market", async (c) => {
    try {
      return c.json(await market.market());
    } catch (err) {
      return unavailable(c, err);
    }
  });

  app.get("/series", async (c) => {
    const tickers = (c.req.query("tickers") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    if (!tickers.length) return c.json({ error: "tickers is required" }, 400);
    try {
      return c.json({ series: await market.series(tickers) });
    } catch (err) {
      return unavailable(c, err);
    }
  });

  return app;
}

function unavailable(c: Context, err: unknown) {
  const message = err instanceof DeskUnavailableError ? err.message : "The desk could not answer";
  return c.json({ error: "desk_unavailable", message }, 503);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  serve({ fetch: createApp().fetch, port: PORT }, (info) => {
    console.log(`eqlty desk on :${info.port}, contract ${DESK_CONTRACT_VERSION}, market ${EQLTY_API_URL}`);
  });
}
