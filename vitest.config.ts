import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
    },
  },
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./testing/server-only.ts", import.meta.url)),
    },
  },
  test: {
    include: [
      "contracts/test/**/*.test.ts",
      "apps/web/test/**/*.test.ts",
      "apps/web/test/**/*.test.tsx",
      "db/src/**/*.test.ts",
      "runtime/**/test/**/*.test.ts",
      "testing/fixtures/**/*.test.ts",
      "tooling/**/*.test.mjs",
    ],
    coverage: {
      enabled: false,
    },
  },
});
