# EQLTY Desk

A Desk for [PerkOS Runtime](https://github.com/PerkOS-xyz/PerkOS-Runtime), on Robinhood Chain. It continues [PerkOS-EQLTY](https://github.com/PerkOS-xyz/PerkOS-EQLTY) and the craft of [PerkOS-Floor](https://github.com/PerkOS-xyz/PerkOS-Floor): the desk drafts, you approve, your wallet signs.

It holds no signing keys and signs nothing. Its one secret is the Uniswap Trading API key, read from the environment.

## What it answers

```
GET  /market                   what can be traded, priced
GET  /series?tickers=          price history for the facts a turn cites
GET  /health                   which contract version it speaks
GET  /quote?ticker=&amountIn=  what Uniswap gives for amountIn atomic USDG, read only
POST /swap                     the unsigned swap your wallet sends to buy
```

`/quote` answers the same question with the same price for 20 seconds. `/swap` takes exactly `{ticker, amountIn, swapper, slippageBps}` and returns calldata for Universal Router 2.1.1 on Robinhood Chain, for the swapper's own wallet to send. When that wallet has not given Permit2 an allowance yet it answers 409 with the allowance to set on chain. Both cap an order at 100 USDG by default and answer 503 until `UNISWAP_API_KEY` is set. The variables are in `.env.example`.

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
