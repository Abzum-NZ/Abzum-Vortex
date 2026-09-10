import { describe, expect, it } from "vitest";
import { safeHttpsUrlSchema } from "../src/common";

describe("HTTPS values", () => {
  it("preserves valid HTTPS addresses", () => {
    expect(safeHttpsUrlSchema.parse("https://example.com/path?value=1")).toBe(
      "https://example.com/path?value=1",
    );
  });

  it.each(["not a URL", "", "https://", "http://example.com", null, {}])(
    "returns a validation failure, rather than throwing, for %j",
    (value) => {
      expect(safeHttpsUrlSchema.safeParse(value).success).toBe(false);
    },
  );
});
