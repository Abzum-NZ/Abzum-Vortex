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
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
    },
  },
  // These closures retain the owning instance while another object's callbacks use their own `this`.
  {
    files: ["apps/web/app/_lib/private-invalidation-socket.ts", "db/src/request-lifetime.ts"],
    rules: { "@typescript-eslint/no-this-alias": "off" },
  },
  // These expressions deliberately reject ASCII control characters in user supplied text.
  {
    files: [
      "contracts/src/application-attachment-blocks.ts",
      "runtime/connection/src/outbound-target-policy.ts",
      "runtime/file/src/file-metadata.ts",
      "ui/src/components/notice.tsx",
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
      "runtime/access/src/record-share-grants.ts",
      "runtime/file/src/file-metadata.ts",
      "runtime/page/src/stored-page-capability.ts",
    ],
    rules: { "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }] },
  },
  // Public callback signatures retain these named but unused arguments.
  {
    files: [
      "apps/web/scripts/development-setup/install.ts",
      "ui/src/layout-styles.ts",
      "ui/src/navigation/account-actions.tsx",
    ],
    rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] },
  },
  // postgres.Options uses the library's empty generic parameter to select its default shape.
  {
    files: ["db/src/request-transaction.ts"],
    rules: { "@typescript-eslint/no-empty-object-type": "off" },
  },
  // This timer must be declared before callbacks that can fire before it is assigned.
  { files: ["db/src/request-owned-socket.ts"], rules: { "prefer-const": "off" } },
  // `problem` throws, so each switch arm terminates without an explicit break.
  {
    files: ["apps/web/app/_lib/studio-application-installation.ts"],
    rules: { "no-fallthrough": "off" },
  },
  // The rich text schema makes the emphasis style exhaustive at runtime.
  { files: ["ui/src/display/rich-text.tsx"], rules: { "no-fallthrough": "off" } },
);
