/**
 * What the trading routes read from the environment, and the Robinhood Chain
 * addresses they are allowed to name.
 *
 * The one secret is the Uniswap Trading API key. It is read here, sent only
 * in the x-api-key header to the Trading API, and never logged or returned.
 * Without it the routes still answer, with 503, so the rest of the desk keeps
 * working on a host that has no key yet.
 *
 * A malformed value stops the service at boot instead of being guessed at: a
 * cap that silently became something else would move a real order.
 */

export type EvmAddress = `0x${string}`;

export const ROBINHOOD_CHAIN_ID = 4663;
/** USDG, what every order spends. It answers decimals() with 6 on chain. */
export const USDG_ADDRESS: EvmAddress = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const USDG_DECIMALS = 6;
/** Universal Router 2.1.1, the only contract a built swap may call. */
export const UNIVERSAL_ROUTER_ADDRESS: EvmAddress = "0x8876789976decbfcbbbe364623c63652db8c0904";
export const PERMIT2_ADDRESS: EvmAddress = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const DEFAULT_UNISWAP_API_URL = "https://trade-api.gateway.uniswap.org/v1";
const DEFAULT_ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
/** 100 USDG in atomic units, the desk's per-order ceiling. */
const DEFAULT_MAX_AMOUNT = "100000000";
/**
 * A read-only quote has no wallet behind it, but the Trading API wants a
 * swapper to price for. This stand-in holds no key anyone uses, so a quote
 * priced for it can never be sent. Override it with UNISWAP_QUOTE_SWAPPER.
 */
const DEFAULT_QUOTE_SWAPPER: EvmAddress = "0x000000000000000000000000000000000000dEaD";

export interface TradingConfig {
  /** null when the host has no key: quote and swap then answer 503. */
  uniswapApiKey: string | null;
  uniswapApiUrl: string;
  /** null only when a caller builds the config without one, as tests do. */
  robinhoodRpcUrl: string | null;
  quoteSwapper: EvmAddress;
  /** The largest amountIn /quote prices, in atomic USDG. */
  quoteMaxAmount: bigint;
  /** The largest amountIn /swap builds, in atomic USDG. */
  swapMaxAmount: bigint;
}

type Env = Record<string, string | undefined>;

const value = (env: Env, name: string): string | undefined => env[name]?.trim() || undefined;

export function loadTradingConfig(env: Env = process.env): TradingConfig {
  return {
    uniswapApiKey: apiKey(env, "UNISWAP_API_KEY"),
    uniswapApiUrl: url(env, "UNISWAP_API_URL", DEFAULT_UNISWAP_API_URL),
    robinhoodRpcUrl: url(env, "ROBINHOOD_RPC_URL", DEFAULT_ROBINHOOD_RPC_URL),
    quoteSwapper: address(env, "UNISWAP_QUOTE_SWAPPER", DEFAULT_QUOTE_SWAPPER),
    quoteMaxAmount: amount(env, "EQLTY_AGENT_QUOTE_MAX_AMOUNT"),
    swapMaxAmount: amount(env, "EQLTY_AGENT_SWAP_MAX_AMOUNT"),
  };
}

/**
 * A key goes into a request header, and a header that cannot carry it makes
 * fetch throw an error that quotes the value. So a key with a space, a line
 * break or anything outside visible ASCII stops the boot, without repeating it.
 */
function apiKey(env: Env, name: string): string | null {
  const raw = value(env, name);
  if (raw === undefined) return null;
  if (!/^[\x21-\x7E]+$/.test(raw)) throw new Error(`${name} must be plain visible ASCII`);
  return raw;
}

function url(env: Env, name: string, fallback: string): string {
  const raw = value(env, name) ?? fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an http or https URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${name} must be an http or https URL`);
  }
  return raw.replace(/\/+$/, "");
}

function address(env: Env, name: string, fallback: EvmAddress): EvmAddress {
  const raw = value(env, name) ?? fallback;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error(`${name} must be a 0x address`);
  return raw as EvmAddress;
}

function amount(env: Env, name: string): bigint {
  const raw = value(env, name) ?? DEFAULT_MAX_AMOUNT;
  if (!/^[1-9]\d{0,77}$/.test(raw) || BigInt(raw) >= 2n ** 256n) {
    throw new Error(`${name} must be a positive whole number of atomic USDG`);
  }
  return BigInt(raw);
}
