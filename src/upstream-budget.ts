/**
 * A ceiling on how many fresh Trading API lookups a route may start in a
 * sliding window. The numbers are the desk's own choice, not a Uniswap limit:
 * they keep one busy caller from spending the API key everyone shares.
 */
export class UpstreamBudget {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly perClient: number | undefined;
  private readonly starts: number[] = [];
  private readonly byClient = new Map<string, number[]>();

  /**
   * `perClient` gives each caller its own share of the window, so one caller
   * spending junk requests cannot use up the budget everyone else relies on.
   */
  constructor(limit: number, windowMs: number, now: () => number = Date.now, perClient?: number) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.perClient = perClient;
  }

  /** Spends one start and returns 0, or returns the seconds until one frees up. */
  take(client?: string): number {
    const now = this.now();
    const own = client && this.perClient ? this.windowFor(client, now) : null;
    if (own && this.perClient && own.length >= this.perClient) return this.wait(own, now);
    this.prune(this.starts, now);
    if (this.starts.length >= this.limit) return this.wait(this.starts, now);
    this.starts.push(now);
    own?.push(now);
    return 0;
  }

  private windowFor(client: string, now: number): number[] {
    let starts = this.byClient.get(client);
    if (!starts) {
      // A bounded map: forgetting an idle caller only resets its own share.
      if (this.byClient.size >= 1_000) this.byClient.clear();
      starts = [];
      this.byClient.set(client, starts);
    }
    this.prune(starts, now);
    return starts;
  }

  private prune(starts: number[], now: number): void {
    while (starts.length > 0 && starts[0]! <= now - this.windowMs) starts.shift();
  }

  private wait(starts: number[], now: number): number {
    return Math.max(1, Math.ceil((starts[0]! + this.windowMs - now) / 1_000));
  }
}
