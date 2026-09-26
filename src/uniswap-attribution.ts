/**
 * X-Agent-Info, the optional header the Uniswap Trading API reads to tell
 * agent traffic apart. It is analytics only: sending it, leaving it out or
 * sending a bad value never changes a response. The checks below are the
 * rules the Trading API reference gives for the header. The gateway drops a
 * value that breaks them and says so in the x-agent-info-status response
 * header, so the desk refuses to build such a value at all. Only constants go
 * in it, never a wallet, a user, an email or a token.
 */

export const decisionOrigins = ["autonomous", "human_mediated"] as const;

export type DecisionOrigin = (typeof decisionOrigins)[number];

/** The origin a Trading API call carried and what the gateway said about it. */
export interface UniswapAttribution {
  decisionOrigin: DecisionOrigin;
  /** The x-agent-info-status response header, or null when there was none. */
  status: string | null;
}

/**
 * How the desk names itself in the header. No version: a number kept by hand
 * would drift from the release.
 */
export const integrationName = "eqlty";

const MAX_FIELD_UNITS = 256;
const MAX_HEADER_BYTES = 1_024;
const DISALLOWED_CODE_POINTS = new Set([0x2028, 0x2029, 0xfffd]);

/** The header value, or an error naming the rule the input breaks. */
export function agentInfoHeader(input: { decisionOrigin: string; integrationName?: string; version?: string }): string {
  if (!(decisionOrigins as readonly string[]).includes(input.decisionOrigin)) {
    throw new Error("decision_origin must be exactly autonomous or human_mediated");
  }
  const value: Record<string, string> = { decision_origin: input.decisionOrigin };
  const fields = [
    ["integration_name", input.integrationName],
    ["version", input.version],
  ] as const;
  for (const [key, raw] of fields) {
    if (raw === undefined) continue;
    if (typeof raw !== "string") throw new Error(`${key} must be a string`);
    if (raw.length > MAX_FIELD_UNITS) throw new Error(`${key} exceeds ${MAX_FIELD_UNITS} UTF-16 code units`);
    if (hasDisallowedCharacter(raw)) throw new Error(`${key} contains a disallowed character`);
    value[key] = raw;
  }
  const header = JSON.stringify(value);
  if (!/^[\x20-\x7E]*$/.test(header)) throw new Error("X-Agent-Info must be printable ASCII");
  // Printable ASCII is one byte per character, so the length is the size.
  if (header.length > MAX_HEADER_BYTES) {
    throw new Error(`X-Agent-Info is ${header.length} bytes; the limit is ${MAX_HEADER_BYTES}`);
  }
  return header;
}

/** Control characters (C0, DEL and C1), U+2028, U+2029 and U+FFFD. */
function hasDisallowedCharacter(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      (codePoint >= 0x80 && codePoint <= 0x9f) ||
      DISALLOWED_CODE_POINTS.has(codePoint)
    ) {
      return true;
    }
  }
  return false;
}
