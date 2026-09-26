/**
 * How much each stock token moved and traded on chain in the last 24 hours.
 *
 * The desk's catalogue prices every token but reports no 24h change or
 * volume, so a question like "what is moving?" had nothing to stand on. The
 * pools on Robinhood Chain do: this reads them from a public pair index in
 * batches, keeps the deepest pool per token, and remembers the answer for a
 * couple of minutes. It never holds the market up: a slow or failed read
 * leaves those two numbers unknown, which the desk already reports as null.
 */

const DEFAULT_URL = "https://api.dexscreener.com";
const CHAIN = "robinhood";
/** Addresses per request, the index's own limit. */
const BATCH = 30;
const REQUEST_TIMEOUT_MS = 6_000;
/** The market answers without activity after this long; the reads go on and fill the cache. */
const WAIT_MS = 4_000;
const CACHE_MS = 120_000;

export interface TokenActivity {
  change24hPct: number | null;
  volume24hUsd: number | null;
}

export interface ActivitySource {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  waitMs?: number;
}

type Pair = {
  chainId?: unknown;
  baseToken?: { address?: unknown };
  priceChange?: { h24?: unknown };
  volume?: { h24?: unknown };
  liquidity?: { usd?: unknown };
};

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/** The deepest Robinhood Chain pool for each token asked about, keyed by lowercase address. */
export function deepestPools(pairs: Pair[], wanted: Set<string>): Map<string, TokenActivity> {
  const best = new Map<string, { liquidity: number; activity: TokenActivity }>();
  for (const p of pairs) {
    if (p.chainId !== CHAIN) continue;
    const address = typeof p.baseToken?.address === "string" ? p.baseToken.address.toLowerCase() : "";
    if (!wanted.has(address)) continue;
    const liquidity = num(p.liquidity?.usd) ?? 0;
    const seen = best.get(address);
    if (seen && seen.liquidity >= liquidity) continue;
    best.set(address, { liquidity, activity: { change24hPct: num(p.priceChange?.h24), volume24hUsd: num(p.volume?.h24) } });
  }
  return new Map([...best].map(([address, v]) => [address, v.activity]));
}

export class PoolActivity {
  private readonly baseUrl: string;
  private readonly http: typeof fetch;
  private readonly now: () => number;
  private readonly waitMs: number;
  private cache = new Map<string, { at: number; activity: TokenActivity | null }>();
  private pending: Promise<void> | null = null;

  constructor(source: ActivitySource = {}) {
    this.baseUrl = (source.baseUrl ?? DEFAULT_URL).replace(/\/+$/, "");
    this.http = source.fetchImpl ?? fetch;
    this.now = source.now ?? Date.now;
    this.waitMs = source.waitMs ?? WAIT_MS;
  }

  /** What is known for these addresses right now, waiting a short while for a fresh read. */
  async forAddresses(addresses: string[]): Promise<Map<string, TokenActivity>> {
    const wanted = [...new Set(addresses.map((a) => a.toLowerCase()))];
    const stale = wanted.filter((a) => {
      const hit = this.cache.get(a);
      return !hit || this.now() - hit.at > CACHE_MS;
    });
    if (stale.length && !this.pending) {
      this.pending = this.refresh(stale).finally(() => {
        this.pending = null;
      });
    }
    if (this.pending) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.pending,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.waitMs);
        }),
      ]);
      clearTimeout(timer);
    }
    const out = new Map<string, TokenActivity>();
    for (const a of wanted) {
      const hit = this.cache.get(a)?.activity;
      if (hit) out.set(a, hit);
    }
    return out;
  }

  private async refresh(addresses: string[]): Promise<void> {
    const batches: string[][] = [];
    for (let i = 0; i < addresses.length; i += BATCH) batches.push(addresses.slice(i, i + BATCH));
    for (const batch of batches) {
      const pairs = await this.read(batch);
      // A batch that failed stays as it was, so an outage does not erase what was known.
      if (!pairs) continue;
      const found = deepestPools(pairs, new Set(batch));
      const at = this.now();
      for (const a of batch) this.cache.set(a, { at, activity: found.get(a) ?? null });
    }
  }

  private async read(batch: string[]): Promise<Pair[] | null> {
    try {
      const res = await this.http(`${this.baseUrl}/tokens/v1/${CHAIN}/${batch.join(",")}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const body: unknown = await res.json();
      return Array.isArray(body) ? (body as Pair[]) : null;
    } catch {
      return null;
    }
  }
}

/** The activity reader the desk runs with, or none when DESK_ACTIVITY is "off". */
export function activityFromEnv(env: Record<string, string | undefined> = process.env): PoolActivity | null {
  if (env.DESK_ACTIVITY?.trim().toLowerCase() === "off") return null;
  const url = env.DESK_ACTIVITY_URL?.trim();
  return new PoolActivity(url ? { baseUrl: url } : {});
}
