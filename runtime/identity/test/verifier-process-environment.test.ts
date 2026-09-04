import { describe, expect, it } from "vitest";
import { createVerifierProcessEnvironment } from "../tooling/verifier-process-environment.mjs";

describe("Testing verifier subprocess environment", () => {
  it("inherits launch variables and excludes unrelated parent secrets", () => {
    const environment = createVerifierProcessEnvironment(
      {
        PATH: "test-path",
        SystemRoot: "test-system-root",
        VORTEX_TESTING_MAILTRAP_API_TOKEN: "must-not-reach-child",
        UNRELATED_SENTINEL_SECRET: "must-not-reach-child",
      },
      {
        VORTEX_TESTING_AUTH_API_URL: "https://testing.example.test",
        VORTEX_TESTING_AUTH_ACCESS_TOKEN: "testing-access-token",
        VORTEX_PRODUCTION_AUTH_API_URL: "https://production.example.test",
      },
    );

    expect(environment).toEqual({
      PATH: "test-path",
      SystemRoot: "test-system-root",
      VORTEX_TESTING_AUTH_API_URL: "https://testing.example.test",
      VORTEX_TESTING_AUTH_ACCESS_TOKEN: "testing-access-token",
      VORTEX_PRODUCTION_AUTH_API_URL: "https://production.example.test",
    });
    expect(environment).not.toHaveProperty("VORTEX_TESTING_MAILTRAP_API_TOKEN");
    expect(environment).not.toHaveProperty("UNRELATED_SENTINEL_SECRET");
  });
});
