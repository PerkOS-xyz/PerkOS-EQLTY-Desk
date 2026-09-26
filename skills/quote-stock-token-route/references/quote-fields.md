# Quote fields

`quote-agent.mjs` never talks to Uniswap. It reads the desk's public quote
through PerkOS:

```
GET https://api.perkos.xyz/desks/stocks-robinhood/quote?ticker=<TICKER>&amountIn=<atomic USDG>
```

PerkOS hands the request to the desk service, which holds the Uniswap API key
and calls the Uniswap Trading API `POST /quote`. PerkOS then passes the desk's
answer back as it came: its status, its body, its `cache-control` and its
`retry-after`. `PERKOS_DESK_QUOTE_URL` replaces the whole route URL, for
example to reach another desk; the script sets `ticker` and `amountIn` on it.
The script sends no key, no session and no cookie.

Items marked **Unconfirmed** were not verified against a live quote from the
desk or against the Uniswap documentation. Report them as unknown.

## What the script checks

Before it prints anything, the script refuses a quote that:

- is not on chain `4663`, Robinhood Chain;
- prices another ticker, or another amount than the one requested;
- is not paid in USDG: the input token must be
  `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (any letter case), with the
  symbol `USDG` and 6 decimals;
- has no valid output token address or no output token decimals;
- has no positive output amount;
- has no Uniswap request id.

The output token address is the one the desk priced, from the desk's own
market list, and the script reports it as `receive.token`. The script does
not check it against a second list, because the desk's market is served only
to a signed-in session. The quote carries no shares-per-token multiplier and
no screen reference price, so the script reports the price per token only and
compares it with nothing.

## Output of `quote`

| Field | Meaning |
|---|---|
| `chainId` | Always `4663`, Robinhood Chain. The script refuses any other chain. |
| `ticker` | The Stock Token ticker the quote prices. |
| `requestId` | The Uniswap request id, a unique id for the quote request. The desk takes it from the Uniswap `x-request-id` response header, or from the body `requestId` when the header is absent. Keep it for the record and for support. The script refuses a quote without one. |
| `quotedAt` | When the desk recorded the quote (ISO 8601). A quote is a snapshot. Null when the desk sent none. |
| `pay` | What the desk spends: `amount` in USDG, `atomic` in USDG units (6 decimals) and the USDG `token` address, which the script checks against the USDG address above. |
| `receive` | What the desk gets: the Uniswap output amount in human units and atomic units, the token address the desk priced and its decimals. |
| `executablePrice.usdgPerToken` | `pay` divided by `receive`, rounded half up to 6 decimals. This is the executable price, per token. It is not a price per share: a Stock Token can stand for more or less than one share. |
| `priceImpactPct` | Uniswap `priceImpact`: the impact of this trade on the pool price, as a percentage from 0 to 100. The Uniswap schema defines it on AMM (`CLASSIC`) quotes only, so expect null for UniswapX. |
| `gasFeeUsd` | Uniswap `gasFeeUSD`: the estimated total gas cost of the swap transaction. The Uniswap schema says it is denominated in USDC. UniswapX quote schemas do not define it, so expect null for them. |
| `routing` | The Uniswap `routing` value, how it settles, and whether it is a documented value. See the table below. |
| `route` | A summary of the Uniswap `route`. See below. |
| `protocols.considered` | The Uniswap `protocols` the quote was allowed to use, as reported by the desk. Null when not reported. |
| `protocols.excluded` | Protocol families the quote was not allowed to use: `V2`, `V3`, `V4` or `UNISWAPX`. Null when `considered` is unknown. |
| `attribution` | The X-Agent-Info attribution the desk sent with the quote. See below. |
| `gaps` | Plain sentences naming every piece of data the desk did not provide. Report each one. |
| `notice` | Confirms that no calldata was built and nothing was signed, deployed or submitted. |

### Route

The Uniswap `route` is a list of paths. Each path is a list of pools (hops),
and the input is split across paths. For each path the script reports
`sharePct` (the share of the input that enters the path, from the first hop's
`amountIn`) and each hop:

| Hop field | Meaning |
|---|---|
| `protocol` | `V2`, `V3` or `V4`, from the Uniswap pool type `v2-pool`, `v3-pool` or `v4-pool`. Null for any other type. |
| `pool` | The pool identifier Uniswap returned. For v4 the Uniswap example shows a 32-byte pool id, not a contract address. |
| `tokenIn`, `tokenOut` | Symbols of the hop's input and output tokens. |
| `feePct` | The pool fee as a percentage. For v3 and v4 the Uniswap fee is in hundredths of a basis point, so `500` is 0.05% and `3000` is 0.3%. A value above `1000000` is reported as null. For v2 pools, which carry no fee field, Uniswap documents a flat 0.30%. |
| `tickSpacing` | The pool tick spacing, when present (v4). |
| `hooks` | For v4 pools, the hook address. The zero address means the pool has no hook. |

The Uniswap schema text describes `fee` as basis points, while its own route
example pairs `fee: "500"` with 0.05%. The script follows the example and the
v4 fee documentation (fees in steps of 0.0001%).

UniswapX quotes return no pool-by-pool route, so an empty `route.paths` is
expected for them. An empty route on a `CLASSIC` quote means the detail is
missing.

### Routing types

| `routing` | Settles as |
|---|---|
| `CLASSIC` | A swap through Uniswap AMM pools (v2, v3, v4). A transaction the swapper sends and pays gas for. |
| `DUTCH_V2`, `DUTCH_V3`, `PRIORITY`, `LIMIT_ORDER` | A UniswapX order. The swapper signs it and a filler settles it onchain, so it is gasless for the swapper. |
| `WRAP`, `UNWRAP` | A wrap or unwrap of the native token, sent as a transaction. |
| `BRIDGE` | A cross-chain bridge, sent as a transaction. |
| `CHAINED` | A multi-step plan executed as ordered steps. |
| `DUTCH_LIMIT` | Listed by the Uniswap API. **Unconfirmed:** how it settles is not documented. |

Any other value is not a documented Uniswap routing value. `null` means
Uniswap sent no routing value, and the script reports that in `gaps`.

### Protocols and what they exclude

- `protocols` is an allowlist. With `routingPreference: BEST_PRICE` Uniswap
  returns the best route inside it. When it is omitted, Uniswap considers
  both the AMM pools and UniswapX.
- `routingPreference: FASTEST` never considers UniswapX.
- UniswapX joins a quote only above a minimum order value (the routing guide
  gives 300 USDC equivalent, the supported-chains page describes a per-chain
  minimum) or when it beats the AMM route by at least 0.2%. Small quotes
  often return AMM routes only.
- The Uniswap API lists Robinhood Chain (`4663`) as supported, with UniswapX
  V3 available there. UniswapX V2 is not listed for it.
- The desk requests `protocols: ["V4"]` with `BEST_PRICE` and
  `EXACT_INPUT`. A quote made that way excludes v2, v3 and UniswapX by
  request, which the output shows as `excluded: ["V2", "V3", "UNISWAPX"]`.

An excluded protocol was not requested. **Unconfirmed:** whether Robinhood
Chain has v2 or v3 liquidity for Stock Tokens, and whether UniswapX fillers
quote Stock Tokens there.

### Attribution

- `decisionOrigin` is the `decision_origin` the desk sent in the
  X-Agent-Info header. The public quote is asked by an agent on its own, so
  the desk sends `autonomous`.
- `status` mirrors the Uniswap `x-agent-info-status` response header. Uniswap
  sets it to `malformed` only when the header failed to parse and was
  dropped, and leaves it absent otherwise. The desk reports an absent header
  as null.
- Attribution is analytics only. It never changes the quote.

## Amount details

- USDG on Robinhood Chain is `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`
  with 6 decimals (read on chain with `symbol()` and `decimals()`).
- The quote is `EXACT_INPUT`: the USDG amount is fixed and the Stock Token
  amount is the quote.
- The desk quotes at most 100 USDG (`100000000` atomic) by default and
  answers `400 amount_above_limit` above its limit.
- If the Uniswap API key carries an integrator fee, Uniswap does not subtract
  it from an `EXACT_INPUT` output amount. **Unconfirmed:** whether the desk's
  key carries one. The desk does not expose Uniswap `aggregatedOutputs`, where
  such a fee would appear.
- The desk copies the Uniswap `quote.priceImpact`, `quote.gasFeeUSD` and
  `quote.route` into `priceImpactPct`, `gasFeeUsd` and `route`. When Uniswap
  leaves one out, `priceImpactPct` and `gasFeeUsd` are null and `route` is an
  empty list, which the script reports in `gaps`.

## Errors

The desk answers every error as `{ error, message }`, and PerkOS passes it on
unchanged. PerkOS answers four errors itself in the same shape
(`invalid_module`, `unknown_module`, `rate_limited` and `desk_unavailable`).
Anything else PerkOS answers, such as an unhandled failure, comes as
`{ error: { code, message } }`, and the script reads both shapes.

| Answer | Cause | What the script says |
|---|---|---|
| `400 invalid_ticker`, `400 invalid_amount`, `400 amount_above_limit` | The ticker or amount is malformed, or the amount is above the desk's limit. | The desk rejected the request. |
| `400 invalid_module` | The desk name in the route URL is not a valid desk name. Only a wrong `PERKOS_DESK_QUOTE_URL` can cause it. | PerkOS does not know that desk. Check `PERKOS_DESK_QUOTE_URL`. There is no executable price. |
| `404 unknown_module` | PerkOS has no desk by the name in the route URL. Only a wrong `PERKOS_DESK_QUOTE_URL` can cause it. | PerkOS does not know that desk. Check `PERKOS_DESK_QUOTE_URL`. There is no executable price. |
| `429 rate_limited` with a `retry-after` header | PerkOS or the desk is limiting quotes. PerkOS allows 20 public quotes a minute per caller and 60 a minute for all public callers together. The desk allows 20 fresh quotes a minute per caller (counted on the caller's IP, which PerkOS forwards) and 120 a minute for everyone; a repeat of a quote it still holds costs nothing. | PerkOS or the desk is limiting new quotes. Wait the `retry-after` seconds before asking again, and do not retry in a loop. |
| `404 asset_not_found` | The ticker is not a Robinhood Stock Token in the desk's market. | No executable quote for the ticker. Do not substitute another asset. |
| `404 not_uniswap_routable` | The desk's market does not report the token tradeable, and a 1 USDG check quote for it failed too. | No executable quote for the ticker. Do not substitute another asset. |
| `404 { "error": "not_found" }` with no message | The URL reached a desk service at a path it does not serve. | There is no desk quote route at that URL. |
| `404` with a body that is not JSON (`404 Not Found`) | PerkOS has no desk quote route at that URL: the route is not deployed there yet, or the URL is wrong. | There is no desk quote route at that URL. It may not be deployed on PerkOS yet, or `PERKOS_DESK_QUOTE_URL` is wrong. There is no executable price. Do not retry in a loop. |
| `502 uniswap_quote_failed` with the message `Uniswap quote failed with status 404` | Uniswap answered its own no-quote `404`. | Uniswap returned no quote and the cause is unknown. There is no executable price. |
| `502 uniswap_quote_failed` with any other message | Any other failed Uniswap answer: another non-2xx status (a `429` is retried, up to three attempts in all), an answer without an output amount, or a Uniswap call that timed out (`The operation was aborted due to timeout`). | The quote is unavailable upstream. There is no executable price. |
| `502 token_decimals_unavailable` | The desk could not read the stock token's decimals on Robinhood Chain. | The quote is unavailable upstream. There is no executable price. |
| `502 catalog_unavailable` | The desk's market behind the quote failed. | The quote is unavailable upstream. There is no executable price. |
| `503 quote_unavailable` | Uniswap quoting, or the Robinhood Chain RPC that reads token decimals, is not configured on the desk. | The quote is unavailable upstream. There is no executable price. |
| `503 desk_unavailable` | PerkOS could not get an answer from the desk: the desk did not answer within 15 seconds, is down, answered something that is not a JSON object, or has no service configured. | The desk is not answering through PerkOS. There is no executable price right now. Ask again later, and do not retry in a loop. |
| Any other status, such as `500` | An unhandled failure. | The quote request failed. There is no executable price. |
| No answer, an unreadable answer or a non-JSON answer | The route could not be reached, the script's own 30 second timeout ran out ("The operation was aborted due to timeout"), or the answer was not JSON. | The message says which. |

The desk repeats an answer for the same ticker and size for a short while: a
`404` or `502` for 10 seconds and a quote for 20 seconds. The quote's
`cache-control` says how many of those seconds are left. Asking again sooner
returns the same answer, so wait before asking again. The desk keeps these
answers in its own memory, so a restart of the desk clears them.

The desk does not forward the Uniswap `errorCode`. For a `/quote` `404` the
Uniswap schema (`QuoteErr404`) lists codes such as `NoRouteFoundError` (no
route with sufficient liquidity for the pair), `QuoteAmountTooLowError` (below
the minimum quotable size for the requested protocols),
`UnsupportedTokenError`, `UnsupportedChainError`,
`UniswapXNotSupportedOnChainError` and `UpstreamTimeoutError` (a routing
dependency timed out, and the request may succeed on retry). All of them reach
the script as `502 uniswap_quote_failed` with `status 404` in the message, so
report the cause as unknown and never guess which code it was.

## Sources

- The desk's behavior (error answers, limits, repeat window, copied Uniswap
  fields): `src/quote.ts`, `src/trade-routes.ts`, `src/uniswap-client.ts` and
  `src/tokens.ts` in the EQLTY Desk repository.
- The PerkOS pass-through (`invalid_module`, `unknown_module`, its own
  `rate_limited`, `desk_unavailable`, the 15 second wait):
  `src/routes/desks.ts` and `src/services/desks/httpVenue.ts` in PerkOS-API.
- Uniswap Trading API reference: https://trade-api.gateway.uniswap.org/v1/api.json
- Swap routing: https://developers.uniswap.org/docs/trading/swapping-api/concepts/swap-routing
- AMM vs UniswapX routing: https://developers.uniswap.org/docs/trading/swapping-api/amm-vs-uniswapx-routing
- Supported chains: https://developers.uniswap.org/docs/trading/swapping-api/supported-chains
- Swapping flow: https://developers.uniswap.org/docs/trading/swapping-api/getting-started
- Fees: https://developers.uniswap.org/docs/get-started/concepts/fees
- Agent attribution: https://developers.uniswap.org/docs/trading/swapping-api/start-building/agent-attribution
