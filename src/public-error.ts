/**
 * The part of an upstream error that is safe to hand back to a caller.
 *
 * A provider's message can carry the request it refused: a URL, a request
 * body, a long hex blob. None of that belongs in an answer, so any message
 * that looks like it is replaced whole instead of being trimmed.
 */

const PROVIDER_DIAGNOSTICS = ["request body:", "request arguments:", "contract call:", "raw transaction"];

export function publicErrorMessage(error: unknown, fallback = "Request failed"): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim();
  if (!message) return fallback;
  const lower = message.toLowerCase();
  if (
    PROVIDER_DIAGNOSTICS.some((marker) => lower.includes(marker)) ||
    /https?:\/\//i.test(message) ||
    /0x[0-9a-f]{128,}/i.test(message)
  ) {
    return "The external provider rejected the request.";
  }
  return message.slice(0, 512);
}
