/**
 * The Uniswap Trading API, for the two things this desk asks of it: a price
 * for spending USDG on one stock token, and the swap a wallet sends to buy it.
 *
 * It signs nothing. When a quote says the wallet still needs a Permit2
 * permit, the desk does not sign one for a wallet it does not hold: it throws
 * Permit2AllowanceRequiredError, and the wallet sets the allowance on chain
 * and asks again. A built swap is checked before anyone sees it: it must call
 * Universal Router 2.1.1, from the wallet that asked, with no native value, on
 * Robinhood Chain. Anything else is refused and no calldata leaves.
 *
 * Every call carries the key in x-api-key, the router version, and the
 * X-Agent-Info header with the decision origin its caller names.
 */

import {
  PERMIT2_ADDRESS,
  ROBINHOOD_CHAIN_ID,
  UNIVERSAL_ROUTER_ADDRESS,
  USDG_ADDRESS,
  type EvmAddress,
} from "./config.ts";
import {
  agentInfoHeader,
  integrationName,
  type DecisionOrigin,
  type UniswapAttribution,
} from "./uniswap-attribution.ts";

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 12_000;
/** The protocols every quote request asks the Trading API for. */
export const quoteProtocols = ["V4"] as const;

type JsonRecord = Record<string, unknown>;

export interface UniswapQuote {
  amountOut: string;
  requestId?: string;
  /** Falls back to "V4" when the API sent no routing. */
  routing: string;
  /** Price impact in percent, 0 to 100, as the Trading API reports it. */
  priceImpactPct?: number;
  /** The pools of the route, as the Trading API returned them. */
  route?: unknown[];
  /** The Trading API's gasFeeUSD estimate. */
  gasFeeUsd?: string;
  /** The routing value exactly as the API sent it, empty when it sent none. */
  reportedRouting?: string;
  attribution?: UniswapAttribution;
}

export interface UniswapTransaction {
  to: EvmAddress;
  from: EvmAddress;
  data: `0x${string}`;
  value: string;
  chainId: number;
}

/** A USDG to stock token swap for a wallet that pays with its own USDG. Unsigned. */
export interface WalletBuySwap {
  /** The swapper's output in the quote's aggregatedOutputs. */
  amountOut: string;
  /** minAmount of that same output: the least the wallet receives. */
  minAmountOut: string;
  requestId: string;
  routing: string;
  transaction: UniswapTransaction;
  attribution: UniswapAttribution;
}

/**
 * A quote for a wallet carried permitData, so the wallet has no Permit2
 * allowance for the router yet. The wallet sets it on chain and asks again.
 */
export class Permit2AllowanceRequiredError extends Error {
  readonly token: EvmAddress;
  readonly spender: EvmAddress;
  readonly amount: string;
  readonly permit2: EvmAddress;

  constructor(token: EvmAddress, spender: EvmAddress, amount: string, permit2: EvmAddress) {
    super("The wallet has no Permit2 allowance for the Universal Router");
    this.name = "Permit2AllowanceRequiredError";
    this.token = token;
    this.spender = spender;
    this.amount = amount;
    this.permit2 = permit2;
  }
}

export interface UniswapSource {
  /** null when the host has no key: nothing is sent and ready() is false. */
  apiKey: string | null;
  apiUrl: string;
  /** Who a read-only quote is priced for. */
  quoteSwapper: EvmAddress;
  fetchImpl?: typeof fetch;
  /** How a retry after a 429 waits. Tests pass one that does not. */
  wait?: (milliseconds: number) => Promise<void>;
}

export class UniswapClient {
  private readonly apiKey: string | null;
  private readonly apiUrl: string;
  private readonly quoteSwapper: EvmAddress;
  private readonly http: typeof fetch;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(source: UniswapSource) {
    this.apiKey = source.apiKey;
    this.apiUrl = source.apiUrl.replace(/\/+$/, "");
    this.quoteSwapper = source.quoteSwapper;
    this.http = source.fetchImpl ?? fetch;
    this.wait = source.wait ?? delay;
  }

  ready(): boolean {
    return Boolean(this.apiKey);
  }

  walletSwapReady(): boolean {
    return Boolean(this.apiKey);
  }

  /** What spending `amount` atomic USDG on tokenOut returns. Read only. */
  async quote(tokenOut: EvmAddress, amount: string, decisionOrigin: DecisionOrigin): Promise<UniswapQuote> {
    if (!this.apiKey) throw new Error("Uniswap quoting is not configured");
    const { body, requestId, agentInfoStatus } = await this.requestQuote({
      tokenIn: USDG_ADDRESS,
      tokenOut,
      amount,
      swapper: this.quoteSwapper,
      slippageTolerance: 1,
      decisionOrigin,
    });
    return { ...parseQuote(body, requestId), attribution: attribution(decisionOrigin, agentInfoStatus) };
  }

  /**
   * Quotes and builds a USDG to stock token swap for a wallet that pays with
   * its own USDG and sends the transaction itself.
   */
  async prepareWalletBuy(input: {
    tokenOut: EvmAddress;
    amount: string;
    swapper: EvmAddress;
    maxSlippageBps: number;
    decisionOrigin: DecisionOrigin;
  }): Promise<WalletBuySwap> {
    if (!this.apiKey) throw new Error("Uniswap wallet swaps are not configured");
    const { body, requestId, agentInfoStatus } = await this.requestQuote({
      tokenIn: USDG_ADDRESS,
      tokenOut: input.tokenOut,
      amount: input.amount,
      swapper: input.swapper,
      slippageTolerance: input.maxSlippageBps / 100,
      decisionOrigin: input.decisionOrigin,
    });
    const parsed = parseQuote(body, requestId);
    if (!parsed.requestId) throw new Error("Uniswap quote returned no request identifier");
    // /swap builds calldata for a CLASSIC quote; UniswapX routings are signed
    // orders that go to /order instead.
    const routing = body.routing;
    if (routing !== "CLASSIC") throw new Error("Uniswap quote routing is not CLASSIC");
    const quote = record(body.quote, "Uniswap quote");
    checkWalletBuyQuote({ quote, swapper: input.swapper, tokenOut: input.tokenOut, amount: input.amount });
    if (body.permitData !== null && body.permitData !== undefined) {
      throw permitAllowanceRequired(record(body.permitData, "Uniswap permit data"), input.amount);
    }
    const output = swapperOutput({
      quote,
      swapper: input.swapper,
      tokenOut: input.tokenOut,
      maxSlippageBps: input.maxSlippageBps,
    });

    const response = await this.http(`${this.apiUrl}/swap`, {
      method: "POST",
      headers: this.headers(input.decisionOrigin),
      body: JSON.stringify({ quote, simulateTransaction: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const swapBody: unknown = await response.json().catch(() => undefined);
    if (!response.ok || !isRecord(swapBody)) {
      throw new Error(`Uniswap swap build failed with status ${response.status}`);
    }
    const transaction = parseTransaction(record(swapBody.swap, "Uniswap swap transaction"));
    checkWalletBuyTransaction(transaction, input.swapper);
    return {
      amountOut: output.amount,
      minAmountOut: output.minAmount,
      requestId: parsed.requestId,
      routing,
      transaction,
      attribution: attribution(input.decisionOrigin, agentInfoStatus, response.headers.get("x-agent-info-status")),
    };
  }

  private async requestQuote(input: {
    tokenIn: EvmAddress;
    tokenOut: EvmAddress;
    amount: string;
    swapper: EvmAddress;
    slippageTolerance: number;
    decisionOrigin: DecisionOrigin;
  }): Promise<{ body: JsonRecord; requestId: string | null; agentInfoStatus: string | null }> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const response = await this.http(`${this.apiUrl}/quote`, {
        method: "POST",
        headers: this.headers(input.decisionOrigin),
        body: JSON.stringify({
          tokenIn: input.tokenIn,
          tokenOut: input.tokenOut,
          amount: input.amount,
          type: "EXACT_INPUT",
          swapper: input.swapper,
          tokenInChainId: ROBINHOOD_CHAIN_ID,
          tokenOutChainId: ROBINHOOD_CHAIN_ID,
          slippageTolerance: input.slippageTolerance,
          routingPreference: "BEST_PRICE",
          protocols: quoteProtocols,
          permitAmount: "EXACT",
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 429 && attempt < MAX_ATTEMPTS) {
        await response.body?.cancel();
        await this.wait(retryDelay(response, attempt));
        continue;
      }
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok || !isRecord(body)) {
        throw new Error(`Uniswap quote failed with status ${response.status}`);
      }
      return {
        body,
        requestId: response.headers.get("x-request-id"),
        agentInfoStatus: response.headers.get("x-agent-info-status"),
      };
    }
    throw new Error("Uniswap quote retry limit reached");
  }

  private headers(decisionOrigin: DecisionOrigin): Record<string, string> {
    if (!this.apiKey) throw new Error("Uniswap API key is missing");
    return {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "x-universal-router-version": "2.1.1",
      "x-agent-info": agentInfoHeader({ decisionOrigin, integrationName }),
    };
  }
}

/** The quote as the Trading API reports it, fields it left out kept empty. */
function parseQuote(body: JsonRecord, headerRequestId: string | null): Omit<UniswapQuote, "attribution"> {
  const quote = isRecord(body.quote) ? body.quote : {};
  const output = isRecord(quote.output) ? quote.output : {};
  const amountOut = String(output.amount ?? quote.amountOut ?? "");
  if (!/^[1-9]\d*$/.test(amountOut)) throw new Error("Uniswap quote returned no output amount");
  const requestId = headerRequestId || (typeof body.requestId === "string" ? body.requestId : undefined);
  const reportedRouting =
    typeof body.routing === "string" ? body.routing : typeof quote.routing === "string" ? quote.routing : undefined;
  return {
    amountOut,
    requestId,
    routing: reportedRouting ?? "V4",
    priceImpactPct:
      typeof quote.priceImpact === "number" && Number.isFinite(quote.priceImpact) ? quote.priceImpact : undefined,
    route: Array.isArray(quote.route) ? quote.route : undefined,
    gasFeeUsd: typeof quote.gasFeeUSD === "string" ? quote.gasFeeUSD : undefined,
    reportedRouting,
  };
}

/**
 * The origin an operation sent, with the first x-agent-info-status any of its
 * responses carried. Every call of one operation sends the same header, so
 * one status speaks for all of them.
 */
function attribution(decisionOrigin: DecisionOrigin, ...statuses: Array<string | null>): UniswapAttribution {
  return { decisionOrigin, status: statuses.find((status) => status !== null) ?? null };
}

/** The quote must be for the wallet that asked, spend exactly its USDG, and pay the wallet back. */
function checkWalletBuyQuote(input: { quote: JsonRecord; swapper: EvmAddress; tokenOut: EvmAddress; amount: string }) {
  const quoteInput = record(input.quote.input, "Uniswap quote input");
  const output = record(input.quote.output, "Uniswap quote output");
  if (!same(input.quote.swapper, input.swapper)) {
    throw new Error("Uniswap quote swapper is not the requested wallet");
  }
  if (!same(quoteInput.token, USDG_ADDRESS) || String(quoteInput.amount) !== input.amount) {
    throw new Error("Uniswap quote input does not match the order");
  }
  if (!same(output.token, input.tokenOut) || !same(output.recipient, input.swapper)) {
    throw new Error("Uniswap quote output does not return to the wallet");
  }
  if (
    Number(input.quote.tokenInChainId ?? input.quote.chainId) !== ROBINHOOD_CHAIN_ID ||
    Number(input.quote.tokenOutChainId ?? input.quote.chainId) !== ROBINHOOD_CHAIN_ID
  ) {
    throw new Error("Uniswap quote is not on Robinhood Chain");
  }
}

/**
 * The allowance a wallet must set before its swap can be built, once the
 * permit the quote asked for is checked: canonical Permit2 on chain 4663, the
 * exact USDG amount, and the Universal Router as spender. Only those three
 * values leave; the permit itself, its nonce and deadline stay here.
 */
function permitAllowanceRequired(permitData: JsonRecord, amount: string): Permit2AllowanceRequiredError {
  const domain = record(permitData.domain, "Permit2 domain");
  const values = record(permitData.values, "Permit2 values");
  const details = record(values.details, "Permit2 details");
  if (Number(domain.chainId) !== ROBINHOOD_CHAIN_ID || !same(domain.verifyingContract, PERMIT2_ADDRESS)) {
    throw new Error("Permit2 domain is not canonical");
  }
  if (!same(details.token, USDG_ADDRESS) || String(details.amount) !== amount) {
    throw new Error("Permit2 amount is not exact");
  }
  if (!same(values.spender, UNIVERSAL_ROUTER_ADDRESS)) {
    throw new Error("Permit2 spender is not the authorized router");
  }
  return new Permit2AllowanceRequiredError(USDG_ADDRESS, UNIVERSAL_ROUTER_ADDRESS, amount, PERMIT2_ADDRESS);
}

/**
 * The wallet's own entry in aggregatedOutputs, the one with no fee tag. This
 * is how the Uniswap interface reads what a recipient will receive: amount is
 * the quoted output and minAmount the least the wallet receives.
 */
function swapperOutput(input: {
  quote: JsonRecord;
  swapper: EvmAddress;
  tokenOut: EvmAddress;
  maxSlippageBps: number;
}): { amount: string; minAmount: string } {
  const outputs = (Array.isArray(input.quote.aggregatedOutputs) ? input.quote.aggregatedOutputs : [])
    .filter(isRecord)
    .filter((output) => output.fee === undefined && same(output.recipient, input.swapper));
  const output = outputs.length === 1 ? outputs[0] : undefined;
  if (!output || !same(output.token, input.tokenOut)) {
    throw new Error("Uniswap quote has no single output for the wallet");
  }
  const amount = String(output.amount ?? "");
  const minAmount = String(output.minAmount ?? "");
  if (!/^[1-9]\d*$/.test(amount) || !/^[1-9]\d*$/.test(minAmount)) {
    throw new Error("Uniswap quote returned no minimum output for the wallet");
  }
  // A minimum under the quoted output less the requested slippage would let
  // the swap settle for less than the caller asked to accept.
  const floor = (BigInt(amount) * BigInt(10_000 - input.maxSlippageBps)) / 10_000n;
  if (BigInt(minAmount) > BigInt(amount) || BigInt(minAmount) < floor) {
    throw new Error("Uniswap minimum output does not match the requested slippage");
  }
  return { amount, minAmount };
}

function parseTransaction(transaction: JsonRecord): UniswapTransaction {
  const data = String(transaction.data ?? "");
  if (!/^0x[0-9a-fA-F]+$/.test(data) || data === "0x") throw new Error("Uniswap transaction has no calldata");
  const to = String(transaction.to ?? "");
  const from = String(transaction.from ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(to) || !/^0x[0-9a-fA-F]{40}$/.test(from)) {
    throw new Error("Uniswap transaction addresses are invalid");
  }
  return {
    to: to as EvmAddress,
    from: from as EvmAddress,
    data: data as `0x${string}`,
    value: String(transaction.value ?? "0"),
    chainId: Number(transaction.chainId),
  };
}

/** The router, the sender, the chain and the value, or no calldata at all. */
function checkWalletBuyTransaction(transaction: UniswapTransaction, swapper: EvmAddress): void {
  if (!same(transaction.to, UNIVERSAL_ROUTER_ADDRESS)) {
    throw new Error(
      `Uniswap returned a transaction for ${transaction.to}, not the configured Universal Router ${UNIVERSAL_ROUTER_ADDRESS}`,
    );
  }
  if (!same(transaction.from, swapper)) throw new Error("Uniswap transaction sender is not the requested wallet");
  if (transaction.chainId !== ROBINHOOD_CHAIN_ID) throw new Error("Uniswap transaction is not on Robinhood Chain");
  let value: bigint;
  try {
    value = BigInt(transaction.value);
  } catch {
    throw new Error("Uniswap transaction value is invalid");
  }
  if (value !== 0n) throw new Error("A USDG purchase cannot include native value");
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1_000, 3_000) : attempt * 500;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  return value;
}

function same(left: unknown, right: string): boolean {
  return String(left ?? "").toLowerCase() === right.toLowerCase();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
