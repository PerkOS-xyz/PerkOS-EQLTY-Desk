# EQLTY Desk

A Desk for [PerkOS Runtime](https://github.com/PerkOS-xyz/PerkOS-Runtime), on Robinhood Chain. It continues [PerkOS-EQLTY](https://github.com/PerkOS-xyz/PerkOS-EQLTY) and the craft of [PerkOS-Floor](https://github.com/PerkOS-xyz/PerkOS-Floor): the desk drafts, you approve, your wallet signs.

It holds no signing keys and signs nothing. Its one secret is the Uniswap Trading API key, read from the environment.

## What it answers

```
GET  /market                   what can be traded, priced
GET  /series?tickers=          price history for the facts a turn cites
GET  /health                   which contract version it speaks
GET  /manifest                 how the desk presents itself and how its team works a turn
GET  /quote?ticker=&amountIn=  what Uniswap gives for amountIn atomic USDG, read only
POST /swap                     the unsigned swap your wallet sends to buy
```

`/manifest` carries the desk's starters, each with the turn it runs (`analyze` or `advise`; none means Sparky answers alone), its screens, the rules and role prompts for each turn, the most one order may spend (`maxOrder`, in USDG) and the venues its orders route to.

`/quote` answers the same question with the same price for 20 seconds. `/swap` takes exactly `{ticker, amountIn, swapper, slippageBps}` and returns calldata for Universal Router 2.1.1 on Robinhood Chain, for the swapper's own wallet to send. When that wallet has not given Permit2 an allowance yet it answers 409 with the allowance to set on chain. Both cap an order at 100 USDG by default and answer 503 until `UNISWAP_API_KEY` is set. The variables are in `.env.example`.

## Team skills

The skills the desk's agents load live under `skills/`. Each one is self-contained in `skills/<name>/` (`SKILL.md`, `agents/`, `references/`, `scripts/`), so it can be fetched on its own at agent boot. They are not part of the service image.

- `quote-stock-token-route` reads the desk's executable Uniswap quote for a Stock Token buy through PerkOS, and reports the price, the route, the price impact and the protocols the quote considered.
- `design-fee-split` turns a fee-sharing intent for a token launch on Robinhood Chain into a Uniswap Liquidity Launchpad plan, and checks the launchpad contracts on chain.

They only read and compute. None of them signs, deploys or submits anything.

Their tests use Node's own test runner:

```
npm run test:skills
```

## Market activity

The catalogue prices every token but reports no 24h change or volume. The desk fills both from each token's deepest pool on Robinhood Chain (a public pair index, 30 tokens per request, cached two minutes). A slow or failed read leaves them `null` and never holds `/market` up. `DESK_ACTIVITY=off` turns it off; `DESK_ACTIVITY_URL` points it elsewhere.

## Development

Node 22.

```
npm install
npm run typecheck
npm test
npm start
```

## License

MIT.
