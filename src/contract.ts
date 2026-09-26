/**
 * The shapes a Desk answers with, mirrored from `@perkos/desk-contract`
 * version 1 in PerkOS-Runtime.
 *
 * They are copied rather than imported because the package is not published
 * yet. Only the types live here, not the schemas: the authority that decides
 * whether an answer is valid is PerkOS, which parses it before any screen
 * draws it. Keeping the check on that side means a desk cannot quietly bless
 * its own malformed answer.
 *
 * When the package ships, this file is replaced by the import and the version
 * below stops being a promise and starts being a dependency.
 */

export const DESK_CONTRACT_VERSION = "1";

export interface DeskAsset {
  ticker: string;
  name: string;
  address: string;
  decimals: number;
  priceUsd: number | null;
  priceAt: string | null;
  change24hPct: number | null;
  volume24hUsd: number | null;
  /** null when this desk cannot tell yet whether an order can be routed. */
  tradeable: boolean | null;
  logoUrl: string | null;
}

export interface DeskMarket {
  chain: string;
  chainId: number;
  /** What an order is priced in. USDG on Robinhood Chain. */
  quoteSymbol: string;
  assets: DeskAsset[];
  observedAt: string;
}

export interface DeskSeriesPoint {
  at: string;
  value: number;
}

export interface DeskSeries {
  ticker: string;
  priceUsd: number | null;
  change24hPct: number | null;
  points: DeskSeriesPoint[];
  /** Who measured it. */
  source: string;
  days?: number;
  low?: number;
  high?: number;
  changePct?: number;
  line?: string;
}

/** The kinds of turn a desk can run. */
export type DeskTurnKind = "analyze" | "advise" | "order";

export interface DeskStarter {
  text: string;
  /** A few words under the question: what the desk will do with it. */
  tag: string;
  /**
   * The turn this question runs when it is tapped. Left out, the question is
   * plain chat: Sparky answers alone and the team is not woken.
   */
  turn?: DeskTurnKind;
}

/** What each role does in one kind of turn. */
export interface DeskRolePrompts {
  scout: string;
  risk: string;
  trader: string;
  auditor: string;
  /** The Uniswap quote specialist, asked with Scout and Risk. Only a client that knows the role reads it. */
  quote?: string;
}

/**
 * What each role does when the person drafts a token launch. The Trader has no
 * part: a launch trades nothing. Only a client that knows launches reads it.
 */
export interface DeskLaunchPrompts {
  scout: string;
  risk: string;
  auditor: string;
  /** The Uniswap hooks specialist: the pool's hook, in plain words. */
  hooks?: string;
  /** The treasury specialist: who earns what from the launch. */
  treasury?: string;
}

/** How the desk presents itself and how its team works a turn. */
export interface DeskManifest {
  tagline: string;
  starters: DeskStarter[];
  screens: Array<"market" | "portfolio" | "history" | "trader">;
  /** What every member of the team keeps in every turn on this desk. */
  rules: string;
  /** A kind of turn left out is one this desk does not run. */
  turns: Partial<Record<"analyze" | "advise" | "order", DeskRolePrompts>> & { launch?: DeskLaunchPrompts };
  /** The most one order may spend, in the market's quote asset (USDG here). */
  maxOrder?: number;
  /**
   * Where the desk trades, named as the team should name it (1 to 8 names).
   * An answer that names another venue is flagged.
   */
  venues?: string[];
}
