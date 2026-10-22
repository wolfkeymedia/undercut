import { describe, expect, it } from "vitest";
import { formatCents, toCents } from "../src/money.js";

describe("toCents", () => {
  it.each([
    ["12.50", 1250],
    ["$1,299.00", 129900],
    ["12,50", 1250],
    ["1.299,00", 129900],
    ["£8", 800],
    [19.99, 1999],
  ])("parses %s", (input, expected) => {
    expect(toCents(input)).toBe(expected);
  });

  it("returns undefined for things that are not prices", () => {
    expect(toCents(null)).toBeUndefined();
    expect(toCents("free")).toBeUndefined();
  });

  it("formats cents as currency", () => {
    expect(formatCents(3250)).toBe("$32.50");
  });
});
