# Uniswap feedback

Feedback from building EQLTY Desk at ETHGlobal Tokyo 2026 (25 to 27 Sep 2026) on the Uniswap Trading API, Universal Router 2.1.1, Permit2 and Uniswap v4 on Robinhood Chain (chain 4663). Our earlier feedback, from ETHGlobal Lisbon, lives in [PerkOS-EQLTY](https://github.com/PerkOS-xyz/PerkOS-EQLTY/blob/main/FEEDBACK.md).

## What we built with Uniswap

- **A Quote agent that argues from a price that could fill.** Each desk turn asks the Trading API what the question's size really buys, with `protocols: ["V4"]`, `hooksOptions: "V4_NO_HOOKS"` and `X-Agent-Info` set to `autonomous`. The agent cites the quote's request id, and anchors its answer on Sepolia under its ENS identity. ([`uniswap-client.ts` L33-L40](https://github.com/PerkOS-xyz/PerkOS-EQLTY-Desk/blob/d19287037efb833b3c47cfa3c97ee3dab42d76ce/src/uniswap-client.ts#L33-L40), [`quote.ts` L31](https://github.com/PerkOS-xyz/PerkOS-EQLTY-Desk/blob/d19287037efb833b3c47cfa3c97ee3dab42d76ce/src/quote.ts#L31))
- **A buy that is always a V4 swap.** `/swap` asks the Trading API for Universal Router 2.1.1 calldata with `X-Agent-Info` set to `human_mediated`, checks the chain, the router, the swapper and a zero value, and hands it to PerkOS API. There, a policy signs only `V4_SWAP` commands to allowlisted contracts under a per-order cap, and a Dynamic delegated wallet signs once the owner holds to approve. ([`swap.ts` L30](https://github.com/PerkOS-xyz/PerkOS-EQLTY-Desk/blob/d19287037efb833b3c47cfa3c97ee3dab42d76ce/src/swap.ts#L30), [`robinhoodPolicy.ts` L65-L69](https://github.com/PerkOS-xyz/PerkOS-API/blob/081317c83deb5516680c5352be12b50c0075a5f7/src/services/wallet/robinhoodPolicy.ts#L65-L69))
- **A launch that opens a Uniswap v4 pool.** The desk's launch turn prepares a Bankr token launch paired with a Stock Token, which creates its own v4 pool.

## What worked well

- **Robinhood Chain out of the box.** USDG to Stock Token routes on v4 came back quoted and built for Universal Router 2.1.1, with no contract of our own.
- **Routing controls that a signing policy can trust.** `protocols` and `hooksOptions` let us keep every route inside the contracts our signer rule lists. We verified `V4_NO_HOOKS` live on chain 4663.
- **X-Agent-Info fits agent products.** `autonomous` for the agent's quotes and `human_mediated` for the owner's swaps describe our flow exactly.
- **Quotes an agent can explain.** Route, pool fees, price impact, gas in USD and a request id give the agent everything it needs to say why a price is what it is, and the request id makes the claim checkable.
- **Permit2 data in the quote** says exactly which allowance a wallet is missing, so we could turn it into a clear on-chain step for the owner.

## Friction, with a suggestion for each

1. **Excluding hooks has a price and no middle ground.** Our delegated wallet may only touch contracts on its signer rule, and hook contracts are not on it, so we request `V4_NO_HOOKS`. Measured live, that cost 0.27% of the output on AAPL and 0.04% on AMD, and nothing on AMZN. *Suggestion:* accept a list of allowed hook addresses in the request, or return each pool's hook address in the route, so a policy can approve specific hooks instead of excluding all of them.
2. **A read-only quote still needs a swapper.** An agent pricing a question has no wallet behind it, so we price for a burn address. *Suggestion:* allow quotes without a swapper, or document the recommended stand-in and mark such a quote as not sendable.
3. **`fee` units disagree.** The schema text describes `fee` as basis points, while its own route example pairs `fee: "500"` with 0.05%. We followed the example and the v4 fee docs. *Suggestion:* align the schema text with the example.
4. **`DUTCH_LIMIT` is listed as a routing value, but how it settles is not documented.** *Suggestion:* document it next to the other UniswapX routings.
5. **Which protocols have liquidity on a chain, per token list.** The supported-chains page lists Robinhood Chain with UniswapX V3, but we could not confirm whether v2 or v3 pools or UniswapX fillers exist for Stock Tokens there. *Suggestion:* a table or endpoint of the protocols with live liquidity per chain.
6. **Attribution has no success signal.** `x-agent-info-status` appears only when the header is malformed and dropped. *Suggestion:* return a positive status such as `accepted`, so an integrator can confirm attribution instead of inferring it from silence.

## One number to reproduce

Quote request `6d22fedeaab35235a50282d756493806`: 50 USDG for 0.2222 NVDA on Robinhood Chain, cited by the Quote agent and anchored on Sepolia in [tx 0x6d5f…2470](https://sepolia.etherscan.io/tx/0x6d5f728303fb9aeca19c987adcd5b9667ca020a06cf079da3f5ba1d31e192470).
