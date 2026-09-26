import { describe, expect, it } from "vitest";
import { IDENTITY } from "../src/identity.ts";
import { createApp } from "../src/server.ts";

describe("EQLTY public identity declaration", () => {
  it("declares the seven real desk roles and gives Trader no ENS write permission", () => {
    expect(IDENTITY.version).toBe("1");
    expect(IDENTITY.seats.map((s) => [s.id, s.writes])).toEqual([
      ["scout", "scout-source"], ["risk", "risk-verdict"], ["trader", null], ["auditor", "auditor-evidence"], ["hooks", "hooks-evidence"], ["quote", "quote-evidence"], ["treasury", "treasury-evidence"],
    ]);
    expect(IDENTITY.seats.every((s) => s.context && s.label)).toBe(true);
  });
  it("serves a keyless public descriptor without changing the existing manifest", async () => {
    const app = createApp();
    const response = await app.request("/identity");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(IDENTITY);
    const manifest = await (await app.request("/manifest")).json();
    expect(manifest).not.toHaveProperty("identity");
    expect(Object.keys(IDENTITY).sort()).toEqual(["deskId", "seats", "version"]);
  });
});
