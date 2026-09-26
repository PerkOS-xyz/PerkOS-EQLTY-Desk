import type { DeskIdentityDescriptor } from "./contract.ts";

/** Public role descriptions only. Private turns and wallet data are never published here. */
export const IDENTITY: DeskIdentityDescriptor = {
  version: "1",
  deskId: "eqlty",
  seats: [
    { id: "scout", label: "Scout", context: "EQLTY Scout gathers public market sources and records the evidence behind the desk's analysis.", writes: "scout-source" },
    { id: "risk", label: "Risk", context: "EQLTY Risk evaluates the desk's evidence and records a risk assessment. A record does not authorize a trade.", writes: "risk-verdict" },
    { id: "trader", label: "Trader", context: "EQLTY Trader prepares orders under the person's existing approval rules. This seat has no ENS record-writing permission.", writes: null },
    { id: "auditor", label: "Auditor", context: "EQLTY Auditor records public evidence for the desk's conclusions. Private conversations and portfolios remain private.", writes: "auditor-evidence" },
    { id: "hooks", label: "Hooks", context: "EQLTY Hooks analyzes the official Uniswap v4 hook registry and records public hook evidence. It never deploys contracts.", writes: "hooks-evidence" },
    { id: "quote", label: "Quote", context: "EQLTY Quote records public Uniswap quote references and route evidence. It cannot authorize or submit trades.", writes: "quote-evidence" },
    { id: "treasury", label: "Treasury", context: "EQLTY Treasury explains fee-sharing proposals and records public configuration evidence. It never moves funds.", writes: "treasury-evidence" },
  ],
};
