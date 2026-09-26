/**
 * Token decimals read on chain. What matters: the RPC must be Robinhood
 * Chain, each token is read once, and a failed read is tried again.
 */

import { describe, expect, it, vi } from "vitest";

import { TokenDecimalsReader } from "../src/token-decimals.ts";

const rpcUrl = "https://rpc.example.test";
const nvda = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const decimalsSelector = "0x313ce567";

describe("token decimals", () => {
  it("reads decimals() on Robinhood Chain once per token", async () => {
    const http = rpc({ chainId: 4663, decimals: 18 });
    const reader = new TokenDecimalsReader({ rpcUrl, fetchImpl: http });

    await expect(reader.decimals(nvda)).resolves.toBe(18);
    await expect(reader.decimals(nvda.toLowerCase() as `0x${string}`)).resolves.toBe(18);

    expect(sentCalls(http).filter((call) => call.method === "eth_call")).toEqual([
      { method: "eth_call", params: [{ to: nvda, data: decimalsSelector }, "latest"] },
    ]);
  });

  it("refuses an RPC that is not Robinhood Chain", async () => {
    const reader = new TokenDecimalsReader({ rpcUrl, fetchImpl: rpc({ chainId: 1, decimals: 18 }) });

    await expect(reader.decimals(nvda)).rejects.toThrow("Token decimals RPC is not Robinhood Chain");
  });

  it("does not keep a failed read", async () => {
    let fail = true;
    const http = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      if (request.method === "eth_call" && fail) return rpcError(request.id);
      return rpcResult(request.id, request.method === "eth_chainId" ? "0x1237" : word(18));
    });
    const reader = new TokenDecimalsReader({ rpcUrl, fetchImpl: http });

    await expect(reader.decimals(nvda)).rejects.toThrow();
    fail = false;
    await expect(reader.decimals(nvda)).resolves.toBe(18);
  });

  it("needs a configured RPC", async () => {
    const reader = new TokenDecimalsReader({ rpcUrl: null, fetchImpl: rpc({ chainId: 4663, decimals: 18 }) });

    expect(reader.ready()).toBe(false);
    await expect(reader.decimals(nvda)).rejects.toThrow("Robinhood Chain RPC is not configured");
  });
});

function rpc(chain: { chainId: number; decimals: number }) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    return rpcResult(
      request.id,
      request.method === "eth_chainId" ? `0x${chain.chainId.toString(16)}` : word(chain.decimals),
    );
  });
}

function sentCalls(http: ReturnType<typeof rpc>) {
  return http.mock.calls.map(([, init]) => {
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    return { method, params };
  });
}

function word(value: number): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function rpcResult(id: number, result: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "content-type": "application/json" },
  });
}

function rpcError(id: number): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "execution reverted" } }), {
    headers: { "content-type": "application/json" },
  });
}
