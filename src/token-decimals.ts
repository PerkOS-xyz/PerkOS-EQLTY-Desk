/**
 * ERC-20 decimals() read on Robinhood Chain, once per token for the life of
 * the process. The market lists tokens as Robinhood issues them, so a token's
 * decimals are read from its contract instead of being assumed. A failed read
 * is not kept, so the next request tries again.
 *
 * Read only: a public client and an eth_call, nothing that can sign.
 */

import { createPublicClient, http } from "viem";

import { ROBINHOOD_CHAIN_ID, type EvmAddress } from "./config.ts";

const TIMEOUT_MS = 12_000;

const decimalsAbi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

export interface DecimalsSource {
  /** The Robinhood Chain RPC. null means the reader is not configured. */
  rpcUrl: string | null;
  fetchImpl?: typeof fetch;
}

export class TokenDecimalsReader {
  private readonly rpcUrl: string | null;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly known = new Map<string, Promise<number>>();

  constructor(source: DecimalsSource) {
    this.rpcUrl = source.rpcUrl;
    this.fetchImpl = source.fetchImpl;
  }

  ready(): boolean {
    return Boolean(this.rpcUrl);
  }

  decimals(token: EvmAddress): Promise<number> {
    const key = token.toLowerCase();
    let pending = this.known.get(key);
    if (!pending) {
      pending = this.read(token);
      this.known.set(key, pending);
      pending.catch(() => {
        this.known.delete(key);
      });
    }
    return pending;
  }

  private async read(token: EvmAddress): Promise<number> {
    if (!this.rpcUrl) throw new Error("Robinhood Chain RPC is not configured");
    const client = createPublicClient({
      transport: http(this.rpcUrl, { timeout: TIMEOUT_MS, ...(this.fetchImpl ? { fetchFn: this.fetchImpl } : {}) }),
    });
    if ((await client.getChainId()) !== ROBINHOOD_CHAIN_ID) {
      throw new Error("Token decimals RPC is not Robinhood Chain");
    }
    return client.readContract({ address: token, abi: decimalsAbi, functionName: "decimals" });
  }
}
