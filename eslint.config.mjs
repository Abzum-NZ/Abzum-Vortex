import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/.next/**",
      "**/coverage/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/.pnpm-store/**",
    ],
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
    files: ["apps/web/app/_lib/private-invalidation-socket.ts", "packages/platform/src/db/request-lifetime.ts"],
    rules: { "@typescript-eslint/no-this-alias": "off" },
  },
  // These expressions deliberately reject ASCII control characters in user supplied text.
  {
    files: [
      "packages/platform/src/files/application-attachment-blocks.ts",
      "packages/platform/src/connections/outbound-target-policy.ts",
      "packages/platform/src/files/file-metadata.ts",
      "packages/ui/src/components/notice.tsx",
    ],
    rules: { "no-control-regex": "off" },
  },
  // Object rest removes these fields before forwarding the remaining product data.
  {
    files: [
      "apps/web/app/_lib/definition-catalogue.ts",
      "apps/web/app/_lib/guided-form-steps.ts",
      "apps/web/app/_lib/studio-application-installation.ts",
      "apps/web/app/studio/_components/application-search-editor.tsx",
      "packages/platform/src/access/record-share-grants.ts",
      "packages/platform/src/files/file-metadata.ts",
      "packages/platform/src/pages/stored-page-capability.ts",
    ],
    rules: { "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }] },
  },
  // Public callback signatures retain these named but unused arguments.
  {
    files: [
      "apps/web/scripts/development-setup/install.ts",
      "packages/ui/src/layout-styles.ts",
      "packages/ui/src/navigation/account-actions.tsx",
    ],
    rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] },
  },
  // postgres.Options uses the library's empty generic parameter to select its default shape.
  {
    files: ["packages/platform/src/db/request-transaction.ts"],
    rules: { "@typescript-eslint/no-empty-object-type": "off" },
  },
  // This timer must be declared before callbacks that can fire before it is assigned.
  { files: ["packages/platform/src/db/request-owned-socket.ts"], rules: { "prefer-const": "off" } },
  // `problem` throws, so each switch arm terminates without an explicit break.
  {
    files: ["apps/web/app/_lib/studio-application-installation.ts"],
    rules: { "no-fallthrough": "off" },
  },
  // The rich text schema makes the emphasis style exhaustive at runtime.
  { files: ["packages/ui/src/display/rich-text.tsx"], rules: { "no-fallthrough": "off" } },
);
