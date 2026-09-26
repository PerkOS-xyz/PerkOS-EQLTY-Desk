/**
 * X-Agent-Info as the Trading API reference describes it. A value that breaks
 * a rule is dropped by the gateway, so the desk refuses to build one.
 */

import { describe, expect, it } from "vitest";

import { agentInfoHeader } from "../src/uniswap-attribution.ts";

describe("X-Agent-Info header", () => {
  it("builds the compact JSON value the Trading API reads", () => {
    expect(agentInfoHeader({ decisionOrigin: "human_mediated", integrationName: "eqlty", version: "0.1.0" })).toBe(
      '{"decision_origin":"human_mediated","integration_name":"eqlty","version":"0.1.0"}',
    );
    expect(agentInfoHeader({ decisionOrigin: "autonomous" })).toBe('{"decision_origin":"autonomous"}');
  });

  it("accepts a field of exactly 256 UTF-16 code units", () => {
    const header = agentInfoHeader({ decisionOrigin: "autonomous", integrationName: "x".repeat(256) });
    expect(JSON.parse(header)).toEqual({ decision_origin: "autonomous", integration_name: "x".repeat(256) });
  });

  it.each([
    ["an unknown decision origin", { decisionOrigin: "robot" }, "decision_origin"],
    [
      "an integration name over 256 UTF-16 code units",
      { decisionOrigin: "autonomous", integrationName: "x".repeat(257) },
      "exceeds 256 UTF-16 code units",
    ],
    ["a version that ends in U+2028", { decisionOrigin: "autonomous", version: "1.0\u2028" }, "disallowed character"],
  ])("rejects %s", (_label, input, message) => {
    expect(() => agentInfoHeader(input)).toThrow(message);
  });

  it.each(["Autonomous", "HUMAN_MEDIATED", "human-mediated", ""])(
    "treats decision_origin as exact and case-sensitive (%j)",
    (decisionOrigin) => {
      expect(() => agentInfoHeader({ decisionOrigin })).toThrow(
        "decision_origin must be exactly autonomous or human_mediated",
      );
    },
  );

  it.each([
    ["a line feed", "eqlty\n"],
    ["a tab", "eq\tlty"],
    ["a null character", "eqlty\u0000"],
    ["DEL", "eqlty\u007f"],
    ["a C1 control character", "eqlty\u0085"],
    ["U+2029", "eqlty\u2029"],
    ["U+FFFD", "eqlty\uFFFD"],
  ])("rejects %s in a field", (_label, integrationName) => {
    expect(() => agentInfoHeader({ decisionOrigin: "autonomous", integrationName })).toThrow(
      "integration_name contains a disallowed character",
    );
  });

  it("rejects text that is not printable ASCII", () => {
    expect(() => agentInfoHeader({ decisionOrigin: "autonomous", integrationName: "\u00e9quit\u00e9" })).toThrow(
      "printable ASCII",
    );
  });

  it("rejects a value over 1024 bytes once JSON escapes it", () => {
    expect(() =>
      agentInfoHeader({ decisionOrigin: "autonomous", integrationName: '"'.repeat(256), version: '"'.repeat(256) }),
    ).toThrow("the limit is 1024");
  });

  it("rejects a field that is not a string", () => {
    expect(() => agentInfoHeader({ decisionOrigin: "autonomous", version: 1 as unknown as string })).toThrow(
      "version must be a string",
    );
  });
});
