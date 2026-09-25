# EQLTY Desk

A Desk for [PerkOS Runtime](https://github.com/PerkOS-xyz/PerkOS-Runtime): tokenized stocks on Robinhood Chain.

It comes from [PerkOS-EQLTY](https://github.com/PerkOS-xyz/PerkOS-EQLTY), which brought the market and the four seats, and from [PerkOS-Floor](https://github.com/PerkOS-xyz/PerkOS-Floor), which brought the craft: the desk drafts, you hold to approve, your wallet signs.

This repository is the desk itself: what it can trade, what it is worth, and the order it would write. It holds no keys and signs nothing.

## The contract

A Desk answers what Runtime asks of any desk:

```
GET /market            what can be traded, priced
GET /series?tickers=   price history for the facts a turn cites
```

`src/contract.ts` mirrors `@perkos/desk-contract` version 1. PerkOS validates every answer against it before a screen draws it.

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
