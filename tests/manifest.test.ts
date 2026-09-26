/**
 * The manifest against the contract PerkOS parses it with.
 *
 * That parse is strict: a field it does not know, or a value outside its
 * limits, turns the whole manifest into nothing, and the desk falls back to
 * default starters with no Trader. So the fields and limits are checked here,
 * before a deploy, rather than discovered on the person's screen.
 *
 * The order ceiling is also written in words (the rules, the Trader's prompts)
 * and enforced by /swap. The number is checked against all three so the desk
 * cannot promise one limit and apply another.
 */

import { describe, expect, it } from "vitest";

import { loadTradingConfig, USDG_DECIMALS } from "../src/config.ts";
import { MANIFEST } from "../src/manifest.ts";

const MANIFEST_FIELDS = ["tagline", "starters", "screens", "rules", "turns", "maxOrder", "venues"];
const STARTER_FIELDS = ["text", "tag", "turn"];
const SCREENS = ["market", "portfolio", "history", "trader"];
const TURN_KINDS = ["analyze", "advise", "order"];
const ROLES = ["auditor", "risk", "scout", "trader"];
/** Roles a turn may add for a client that knows them: Quote reads Uniswap's executable price. */
const OPTIONAL_ROLES = ["quote"];

describe("the desk's manifest", () => {
  it("keeps to the fields and limits the contract knows", () => {
    for (const key of Object.keys(MANIFEST)) expect(MANIFEST_FIELDS).toContain(key);
    expect(MANIFEST.starters.length).toBeLessThanOrEqual(6);
    for (const s of MANIFEST.starters) {
      for (const key of Object.keys(s)) expect(STARTER_FIELDS).toContain(key);
      if (s.turn !== undefined) expect(TURN_KINDS).toContain(s.turn);
    }
    expect(MANIFEST.screens.length).toBeLessThanOrEqual(6);
    for (const screen of MANIFEST.screens) expect(SCREENS).toContain(screen);
    for (const [kind, roles] of Object.entries(MANIFEST.turns)) {
      if (kind === "launch") {
        // A launch trades nothing: no Trader, and Hooks and Treasury take part.
        expect(Object.keys(roles ?? {}).sort()).toEqual(["auditor", "hooks", "risk", "scout", "treasury"]);
        continue;
      }
      expect(TURN_KINDS).toContain(kind);
      expect(Object.keys(roles ?? {}).filter((r) => !OPTIONAL_ROLES.includes(r)).sort()).toEqual(ROLES);
      for (const prompt of Object.values(roles ?? {})) expect(prompt.length).toBeLessThanOrEqual(1200);
    }
  });

  it("asks Quote to read Uniswap's executable price in every trading turn it runs", () => {
    for (const kind of ["analyze", "advise"] as const) expect(MANIFEST.turns[kind]?.quote).toMatch(/^As Quote: .*Uniswap now.*Open with "@Trader @Risk"/);
  });

  it("gives a drafted launch to Scout, Risk, Hooks, Treasury and the Auditor, with Risk's verdict and the person's hold", () => {
    const launch = MANIFEST.turns.launch;
    expect(launch?.risk).toContain('"VERDICT: GO" or "VERDICT: BLOCK"');
    expect(launch?.hooks).toMatch(/^As Hooks: .*Uniswap v4 pool.*from the facts only/);
    expect(launch?.treasury).toMatch(/^As Treasury: .*from the facts only/);
    expect(launch?.auditor).toContain("never an address");
    for (const prompt of Object.values(launch ?? {})) expect(prompt.length).toBeLessThanOrEqual(1200);
    expect(MANIFEST.rules).toContain("the person holds to launch");
    expect(MANIFEST.rules.length).toBeLessThanOrEqual(1600);
  });

  it("offers History and the Portfolio next to the Market and the Trader", () => {
    expect(MANIFEST.screens).toEqual(["market", "trader", "history", "portfolio"]);
  });

  it("only routes a starter to a turn this desk runs", () => {
    const runs = Object.keys(MANIFEST.turns);
    const routed = MANIFEST.starters.filter((s) => s.turn !== undefined);
    expect(routed.length).toBeGreaterThan(0);
    for (const s of routed) expect(runs).toContain(s.turn);
    // Orders are not a turn on this desk, so no starter may ask for one.
    expect(MANIFEST.starters.some((s) => s.turn === "order")).toBe(false);
  });

  it("leaves the plain question to Sparky alone", () => {
    const plain = MANIFEST.starters.find((s) => s.text === "What can I trade on this desk?");
    expect(plain).toBeDefined();
    expect(plain?.turn).toBeUndefined();
  });

  it("states one order ceiling, in the rules, the Trader's prompts and /swap", () => {
    const cap = MANIFEST.maxOrder;
    expect(cap).toBe(100);
    if (cap === undefined) return;
    expect(Number.isFinite(cap) && cap > 0 && cap <= 1_000_000).toBe(true);
    expect(MANIFEST.rules).toContain(`An order is at most ${cap} USDG.`);
    for (const kind of ["analyze", "advise"] as const) expect(MANIFEST.turns[kind]?.trader).toContain(`at most ${cap}`);
    const atomic = BigInt(cap) * 10n ** BigInt(USDG_DECIMALS);
    const defaults = loadTradingConfig({});
    expect(defaults.swapMaxAmount).toBe(atomic);
    expect(defaults.quoteMaxAmount).toBe(atomic);
  });

  it("names where its orders are routed", () => {
    expect(MANIFEST.venues).toEqual(["Uniswap on Robinhood Chain"]);
    const venues = MANIFEST.venues ?? [];
    expect(venues.length >= 1 && venues.length <= 8).toBe(true);
    for (const venue of venues) {
      expect(venue.trim()).toBe(venue);
      expect(venue.length).toBeGreaterThan(0);
      expect(venue.length).toBeLessThanOrEqual(64);
    }
  });
});
