import { describe, expect, it } from "vitest";
import { isAllowed, parseRobots } from "../src/collectors/http.js";

describe("robots.txt", () => {
  const rules = parseRobots(`
User-agent: Googlebot
Disallow: /

User-agent: *
Disallow: /checkout
Disallow: /*?sort=
Allow: /checkout/help
`);

  it("only applies the wildcard group", () => {
    expect(isAllowed(rules, "/products/espresso")).toBe(true);
  });

  it("blocks disallowed paths and wildcards", () => {
    expect(isAllowed(rules, "/checkout/step1")).toBe(false);
    expect(isAllowed(rules, "/collections/all?sort=price")).toBe(false);
  });

  it("lets a longer Allow win", () => {
    expect(isAllowed(rules, "/checkout/help")).toBe(true);
  });
});
