/**
 * The swap a desk sends from the person's delegated wallet once the person
 * approved the order: USDG from that wallet into one stock token.
 *
 * The desk holds no key for that wallet and signs nothing. It returns the
 * calldata for Universal Router 2.1.1 and the wallet sends it. When the
 * wallet has not given Permit2 an allowance yet, it answers 409 with the
 * allowance to set on chain, never with a permit to sign.
 *
 * The caller asks only after the person approved, so the Trading API hears
 * human_mediated. Answers are never cached: a quote belongs to its swapper.
 * At most 60 swaps are built a minute, 12 per caller, and a ticker that
 * cannot be routed is refused before it spends any of that.
 */

import { USDG_ADDRESS, USDG_DECIMALS, ROBINHOOD_CHAIN_ID, type EvmAddress } from "./config.ts";
import { publicErrorMessage } from "./public-error.ts";
import type { TokenDecimalsReader } from "./token-decimals.ts";
import type { StockToken, StockTokens } from "./tokens.ts";
import type { DecisionOrigin } from "./uniswap-attribution.ts";
import { Permit2AllowanceRequiredError, quoteProtocols, type UniswapClient } from "./uniswap-client.ts";
import { UpstreamBudget } from "./upstream-budget.ts";

/** A buy takes two of a caller's share: the allowance answer, then the swap. */
const SWAPS_PER_MINUTE = 60;
const SWAPS_PER_CLIENT_PER_MINUTE = 12;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const decisionOrigin: DecisionOrigin = "human_mediated";

export interface SwapToken {
  symbol: string;
  address: EvmAddress;
  decimals: number;
}

export interface DeskSwap {
  chainId: 4663;
  /** The Universal Router, checked before it is returned. */
  to: EvmAddress;
  data: `0x${string}`;
  value: "0";
  tokenIn: SwapToken;
  tokenOut: SwapToken;
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  requestId: string;
  routing: string;
  protocols: string[];
}

/** The on-chain Permit2 allowance a swapper must set before asking again. */
export interface Permit2AllowanceNeeded {
  token: EvmAddress;
  spender: EvmAddress;
  amount: string;
}

export class SwapError extends Error {
  readonly status: 400 | 404 | 409 | 429 | 502 | 503;
  readonly code: string;
  readonly extra: {
    /** For a 429, the seconds until a new swap can be built. */
    retryAfterSeconds?: number;
    /** For a 409, the allowance to set on chain. */
    allowance?: Permit2AllowanceNeeded;
  };

  constructor(
    status: 400 | 404 | 409 | 429 | 502 | 503,
    code: string,
    message: string,
    extra: SwapError["extra"] = {},
  ) {
    super(message);
    this.name = "SwapError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export interface SwapDependencies {
  /** The largest amountIn built into one swap, in atomic USDG. */
  maxAmount: bigint;
  tokens: Pick<StockTokens, "find">;
  uniswap: Pick<UniswapClient, "prepareWalletBuy" | "walletSwapReady">;
  decimals: Pick<TokenDecimalsReader, "decimals" | "ready">;
  now?: () => number;
}

export class SwapService {
  private readonly maxAmount: bigint;
  private readonly tokens: Pick<StockTokens, "find">;
  private readonly uniswap: Pick<UniswapClient, "prepareWalletBuy" | "walletSwapReady">;
  private readonly decimals: Pick<TokenDecimalsReader, "decimals" | "ready">;
  private readonly budget: UpstreamBudget;

  constructor(dependencies: SwapDependencies) {
    this.maxAmount = dependencies.maxAmount;
    this.tokens = dependencies.tokens;
    this.uniswap = dependencies.uniswap;
    this.decimals = dependencies.decimals;
    this.budget = new UpstreamBudget(
      SWAPS_PER_MINUTE,
      60_000,
      dependencies.now ?? Date.now,
      SWAPS_PER_CLIENT_PER_MINUTE,
    );
  }

  /** amountIn must already be a positive whole number string, swapper a 0x address, slippageBps 1 to 500. */
  async swap(input: {
    ticker: string;
    amountIn: string;
    swapper: EvmAddress;
    slippageBps: number;
    /** Who is asking, for its share of swap builds. */
    client?: string;
  }): Promise<DeskSwap> {
    const ticker = input.ticker.trim().toUpperCase();
    if (BigInt(input.amountIn) > this.maxAmount) {
      throw new SwapError(
        400,
        "amount_above_limit",
        `amountIn is above this server's limit of ${this.maxAmount} atomic USDG per swap`,
      );
    }
    if (input.swapper.toLowerCase() === ZERO_ADDRESS) {
      throw new SwapError(400, "invalid_swapper", "swapper cannot be the zero address");
    }
    if (!this.uniswap.walletSwapReady()) {
      throw new SwapError(503, "swap_unavailable", "Uniswap swaps are not configured on this server");
    }
    if (!this.decimals.ready()) {
      throw new SwapError(
        503,
        "swap_unavailable",
        "The Robinhood Chain RPC that reads token decimals is not configured on this server",
      );
    }
    let token: StockToken | undefined;
    try {
      token = await this.tokens.find(ticker);
    } catch (err) {
      throw new SwapError(502, "catalog_unavailable", publicErrorMessage(err, "The stock catalog is unavailable"));
    }
    if (!token) {
      throw new SwapError(404, "asset_not_found", `${ticker} is not a Robinhood stock token on chain 4663`);
    }
    if (!token.tradeable) {
      throw new SwapError(404, "not_uniswap_routable", `${ticker} is not marked Uniswap routable in the stock catalog`);
    }
    // Spent only for a request that can reach Uniswap: junk tickers cost nothing.
    const retryAfterSeconds = this.budget.take(input.client);
    if (retryAfterSeconds > 0) {
      throw new SwapError(429, "rate_limited", `Too many swaps on this server; retry in ${retryAfterSeconds} seconds`, {
        retryAfterSeconds,
      });
    }

    const [swapResult, decimalsResult] = await Promise.allSettled([
      this.uniswap.prepareWalletBuy({
        tokenOut: token.address,
        amount: input.amountIn,
        swapper: input.swapper,
        maxSlippageBps: input.slippageBps,
        decisionOrigin,
      }),
      this.decimals.decimals(token.address),
    ]);
    if (swapResult.status === "rejected") throw swapFailure(swapResult.reason);
    if (decimalsResult.status === "rejected") {
      throw new SwapError(
        502,
        "token_decimals_unavailable",
        `The decimals of ${token.ticker} could not be read on Robinhood Chain`,
      );
    }
    const built = swapResult.value;
    return {
      chainId: ROBINHOOD_CHAIN_ID,
      to: built.transaction.to,
      data: built.transaction.data,
      value: "0",
      tokenIn: { symbol: "USDG", address: USDG_ADDRESS, decimals: USDG_DECIMALS },
      tokenOut: { symbol: token.ticker, address: token.address, decimals: decimalsResult.value },
      amountIn: input.amountIn,
      amountOut: built.amountOut,
      minAmountOut: built.minAmountOut,
      requestId: built.requestId,
      routing: built.routing,
      protocols: [...quoteProtocols],
    };
  }
}

function swapFailure(err: unknown): SwapError {
  if (err instanceof Permit2AllowanceRequiredError) {
    return new SwapError(
      409,
      "permit2_allowance_required",
      `The swapper has no Permit2 allowance for the Universal Router yet. From the swapper, make sure the token lets Permit2 (${err.permit2}) spend it, call Permit2 approve(token, spender, amount, expiration), then ask again.`,
      { allowance: { token: err.token, spender: err.spender, amount: err.amount } },
    );
  }
  return new SwapError(502, "uniswap_swap_failed", publicErrorMessage(err, "The Uniswap swap could not be built"));
}
