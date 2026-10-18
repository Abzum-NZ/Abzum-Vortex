export const paths = {
  schema: ["packages/platform/src/schema.ts"],
  platform: ["packages/platform/src/"],
  ui: ["packages/ui/src/"],
  // The official shadcn component sources; every other packages/ui source is a renderer.
  uiComponents: "packages/ui/src/components/",
  uiRenderers: "packages/ui/src/",
  definitions: ["packages/definitions/src/"],
  web: ["apps/web/"],
  // Scripts and development setup name shipped applications on purpose; they are not engines.
  scripts: ["apps/web/scripts/", "apps/web/app/_lib/development-setup/"],
  canonical: "supabase/schemas/",
  migrations: "supabase/migrations/",
  applicationSources: "packages/definitions/src/",
} as const;

export const packageAreas: Record<string, string> = {
  "@vortex/platform": "platform",
  "@vortex/definitions": "definitions",
  "@vortex/ui": "ui",
  "@vortex/web": "web",
};

/**
 * Every rule protects a rule in AGENTS.md or a defect that has happened. A pull request that
 * changes what a rule covers updates or removes the rule in the same pull request. Past its
 * review-by date the guard prints a notice; the lead then keeps, changes or removes the rule.
 */
export const guardRules = {
  "business-name": {
    tier: "blocking",
    owner: "lead",
    reviewBy: "2027-01-15",
    description: "Business application names in generic engines",
  },
  layering: {
    tier: "blocking",
    owner: "lead",
    reviewBy: "2027-01-15",
    description: "Imports that break the package dependency direction",
  },
  "migration-mismatch": {
    tier: "blocking",
    owner: "lead",
    reviewBy: "2027-01-15",
    description: "Canonical SQL functions that differ from their latest migration",
  },
  "migration-orphan": {
    tier: "blocking",
    owner: "lead",
    reviewBy: "2027-01-15",
    description:
      "Functions a forward migration leaves live without a canonical file (the generated baseline is exempt)",
  },
  "sql-identifier-length": {
    tier: "blocking",
    owner: "lead",
    reviewBy: "2027-01-15",
    description: "SQL objects named past 63 characters, which Postgres silently truncates",
  },
  "sql-overload": {
    tier: "blocking",
    owner: "lead",
    reviewBy: "2027-01-15",
    description:
      "A canonical function name declared with more than one signature, which forces Postgres to resolve a call by argument types",
  },
  "migration-version-duplicate": {
    tier: "blocking",
    owner: "lead",
    reviewBy: "2027-01-15",
    description: "Migration files that share a version; a fresh reset fails on the duplicate key",
  },
  "migration-version-order": {
    tier: "blocking",
    owner: "lead",
    reviewBy: "2027-01-15",
    description:
      "A new migration on a branch behind origin/main or whose version is not above the highest on origin/main",
  },
  "function-uuid": {
    tier: "blocking",
    owner: "lead",
    reviewBy: "2027-01-15",
    description: "Hard-coded non-nil UUIDs in SQL functions",
  },
  "migration-owner-role": {
    tier: "blocking",
    owner: "lead",
    reviewBy: "2027-01-15",
    description:
      "Forward migrations must run object DDL under an explicitly set role, not postgres, and end with reset role;",
  },
  "versioned-export": {
    tier: "blocking",
    owner: "lead",
    reviewBy: "2027-01-15",
    description: "Exported identifiers ending in V2 or later",
  },
  "versioned-file": {
    tier: "blocking",
    owner: "lead",
    reviewBy: "2027-01-15",
    description: "Source file names ending in -v2 or later",
  },
  "ui-literal-style": {
    tier: "blocking",
    owner: "lead",
    reviewBy: "2027-01-15",
    description:
      "Literal rounded-*, arbitrary px or arbitrary font-family classes in packages/ui renderers (outside shadcn components; Studio chrome permits its specified md/lg/xl/full radius scale)",
  },
  "file-size": {
    tier: "warning",
    owner: "lead",
    reviewBy: "2026-11-15",
    reviewNote: "Reconsider once #2235 splits the two remaining files",
    description: "Source and canonical SQL files over 1,500 lines",
  },
  "definition-validation": {
    tier: "blocking",
    owner: "lead",
    reviewBy: "2027-01-15",
    reviewNote:
      "Edit-save and offline publication share source rules: only table releases with a declared data contract remain registered, and row-action bindings require matching commands.",
    description:
      "A shipped definition source that publication would refuse (offline compile and validation)",
  },
  "contract-version-parity": {
    tier: "blocking",
    owner: "lead",
    reviewBy: "2027-01-15",
    description:
      "Each definition kind accepts exactly one contract version: vortex_definition.accepted_contract_version returns a single element per kind and the TypeScript source and validation constants equal it",
  },
  "derived-id-parity": {
    tier: "blocking",
    owner: "lead",
    reviewBy: "2027-01-15",
    description:
      "The derived Definition identity in TypeScript and SQL drifting apart: the TypeScript derivation must reproduce the recorded SQL vectors, and the SQL function must be the one they were recorded from",
  },
  "invalid-guard-allow": {
    tier: "blocking",
    owner: "lead",
    reviewBy: "2027-01-15",
    description: "Malformed guard-allow directive or invalid rule id/reason",
  },
  "unused-guard-allow": {
    tier: "warning",
    owner: "lead",
    reviewBy: "2027-01-15",
    description: "A guard-allow directive that matches no finding",
  },
} as const;

export const scannedRuleIds = new Set([
  "business-name",
  "layering",
  "migration-mismatch",
  "migration-orphan",
  "migration-version-duplicate",
  "migration-version-order",
  "sql-identifier-length",
  "sql-overload",
  "function-uuid",
  "migration-owner-role",
  "versioned-export",
  "versioned-file",
  "file-size",
  "ui-literal-style",
  "definition-validation",
  "derived-id-parity",
  "contract-version-parity",
]);
