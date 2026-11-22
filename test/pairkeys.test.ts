import { describe, expect, it } from "vitest";
import { pairKeys } from "../src/web/app.js";

describe("pairKeys", () => {
  it("reads ticked pairs, dropping duplicates and anything malformed", () => {
    const a = JSON.stringify(["10", "them", "1"]);
    const b = JSON.stringify(["11", "them", "2"]);
    expect(pairKeys([a, b, a, "nope", "[]", JSON.stringify(["x", "", "y"]), JSON.stringify([1, 2, 3])])).toEqual([
      { merchantExternalId: "10", competitorStoreId: "them", competitorExternalId: "1" },
      { merchantExternalId: "11", competitorStoreId: "them", competitorExternalId: "2" },
    ]);
  });
});
