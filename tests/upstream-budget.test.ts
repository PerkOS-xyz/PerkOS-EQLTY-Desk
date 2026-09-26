/**
 * The sliding window that keeps the shared Trading API key from being spent
 * by one caller. A refused start must not count, or a caller that keeps
 * asking would never get back in.
 */

import { describe, expect, it } from "vitest";

import { UpstreamBudget } from "../src/upstream-budget.ts";

describe("upstream budget", () => {
  it("grants the limit within the window, then says when one frees up", () => {
    let now = 0;
    const budget = new UpstreamBudget(2, 60_000, () => now);

    expect(budget.take()).toBe(0);
    now = 10_000;
    expect(budget.take()).toBe(0);
    now = 30_000;
    expect(budget.take()).toBe(30);
    now = 59_500;
    expect(budget.take()).toBe(1);
  });

  it("frees each start once it leaves the window", () => {
    let now = 0;
    const budget = new UpstreamBudget(2, 60_000, () => now);
    budget.take();
    now = 10_000;
    budget.take();

    now = 60_000;
    expect(budget.take()).toBe(0);
    expect(budget.take()).toBe(10);
    now = 70_000;
    expect(budget.take()).toBe(0);
  });

  it("does not spend a refused start", () => {
    let now = 0;
    const budget = new UpstreamBudget(1, 60_000, () => now);
    budget.take();

    now = 30_000;
    expect(budget.take()).toBe(30);
    expect(budget.take()).toBe(30);
    now = 60_000;
    expect(budget.take()).toBe(0);
  });

  it("gives each caller its own share inside the overall limit", () => {
    const budget = new UpstreamBudget(3, 60_000, () => 0, 2);

    expect(budget.take("a")).toBe(0);
    expect(budget.take("a")).toBe(0);
    expect(budget.take("a")).toBe(60);
    expect(budget.take("b")).toBe(0);
    // The overall limit still holds for a caller with share left.
    expect(budget.take("c")).toBe(60);
  });
});
