# EQLTY Desk

A Desk for [PerkOS Runtime](https://github.com/PerkOS-xyz/PerkOS-Runtime), on Robinhood Chain. It continues [PerkOS-EQLTY](https://github.com/PerkOS-xyz/PerkOS-EQLTY) and the craft of [PerkOS-Floor](https://github.com/PerkOS-xyz/PerkOS-Floor): the desk drafts, you approve, your wallet signs.

It holds no keys and signs nothing.

## What it answers

```
GET /market            what can be traded, priced
GET /series?tickers=   price history for the facts a turn cites
GET /health            which contract version it speaks
```

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
