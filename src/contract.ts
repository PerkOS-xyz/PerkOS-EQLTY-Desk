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
