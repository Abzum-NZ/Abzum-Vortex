import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/.next/**", "**/node_modules/**", "**/.pnpm-store/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
  },
  // The off-theme detector runs in the browser on a rendered page.
  {
    files: ["tooling/theme/off-theme-detector.js"],
    languageOptions: {
      globals: {
        console: "readonly",
        document: "readonly",
        getComputedStyle: "readonly",
        SVGElement: "readonly",
        window: "readonly",
      },
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
    },
  },
  // These closures retain the owning instance while another object's callbacks use their own `this`.
  {
    files: [
      "apps/web/app/_lib/private-invalidation-socket.ts",
      "packages/platform/src/db/request-lifetime.ts",
    ],
    rules: { "@typescript-eslint/no-this-alias": "off" },
  },
  // Object rest removes these fields before forwarding the remaining product data.
  {
    files: [
      "apps/web/app/_lib/definition-catalogue.ts",
      "packages/platform/src/files/file-metadata.ts",
    ],
    rules: { "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }] },
  },
  // postgres.Options uses the library's empty generic parameter to select its default shape.
  {
    files: ["packages/platform/src/db/request-transaction.ts"],
    rules: { "@typescript-eslint/no-empty-object-type": "off" },
  },
  // This timer must be declared before callbacks that can fire before it is assigned.
  { files: ["packages/platform/src/db/request-owned-socket.ts"], rules: { "prefer-const": "off" } },
  // The rich text schema makes the emphasis style exhaustive at runtime.
  { files: ["packages/ui/src/display/rich-text.tsx"], rules: { "no-fallthrough": "off" } },
);
