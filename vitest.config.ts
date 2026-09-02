import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["contracts/test/**/*.test.ts", "tooling/**/*.test.mjs"],
    coverage: {
      enabled: false,
    },
  },
});
