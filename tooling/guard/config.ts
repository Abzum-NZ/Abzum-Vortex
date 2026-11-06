export const paths = {
  platform: ["packages/platform/src/"],
  ui: ["packages/ui/src/"],
  // The official shadcn component sources; every other packages/ui source is a renderer.
  uiComponents: "packages/ui/src/components/",
  uiRenderers: "packages/ui/src/",
  definitions: ["packages/definitions/src/"],
  web: ["apps/web/"],
  // Scripts and development setup name shipped applications on purpose; they are not engines.
  scripts: ["apps/web/scripts/"],
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

/** Every rule protects a product rule in AGENTS.md or the target architecture, or a defect that has happened. */
export const guardRules = {
  "query-input-name-matching": {
    tier: "blocking",
    description: "Query input values must come from explicit bindings through the shared resolver",
  },
  "business-name": {
    tier: "blocking",
    description: "Business application names in generic engines",
  },
  layering: {
    tier: "blocking",
    description: "Imports that break the package dependency direction",
  },
  "migration-mismatch": {
    tier: "blocking",
    description: "Canonical SQL functions that differ from their latest migration",
  },
  "migration-orphan": {
    tier: "blocking",
    description:
      "Functions a forward migration leaves live without a canonical file, excluding signatures removed by DROP FUNCTION [IF EXISTS] (the generated baseline is exempt)",
  },
  "sql-identifier-length": {
    tier: "blocking",
    description: "SQL objects named past 63 characters, which Postgres silently truncates",
  },
  "sql-overload": {
    tier: "blocking",
    description:
      "A canonical function name declared with more than one signature, which forces Postgres to resolve a call by argument types",
  },
  "migration-version-duplicate": {
    tier: "blocking",
    description: "Migration files that share a version; a fresh reset fails on the duplicate key",
  },
  "migration-version-order": {
    tier: "blocking",
    description: "A migration a branch adds whose version is not above the highest on origin/main",
  },
  "function-uuid": {
    tier: "blocking",
    description: "Hard-coded non-nil UUIDs in canonical SQL functions",
  },
  "migration-owner-role": {
    tier: "blocking",
    description:
      "Migrations a branch adds must run object DDL under an explicitly set role, not postgres, and end with reset role;",
  },
  "versioned-export": {
    tier: "blocking",
    description: "Exported identifiers ending in V2 or later",
  },
  "versioned-file": {
    tier: "blocking",
    description: "Source file names ending in -v2 or later",
  },
  "ui-literal-style": {
    tier: "blocking",
    description:
      "Literal rounded-*, arbitrary px or arbitrary font-family classes in packages/ui renderers (outside shadcn components; Studio chrome permits its specified md/lg/xl/full radius scale)",
  },
  "silent-catch": {
    tier: "warning",
    description:
      "A catch in platform services or web server helpers that swallows its cause without logging or rethrowing",
  },
  "definition-validation": {
    tier: "blocking",
    description:
      "A shipped definition source that publication would refuse (offline compile and validation)",
  },
  "contract-version-parity": {
    tier: "blocking",
    description:
      "Each definition kind accepts exactly one contract version: vortex_definition.accepted_contract_version returns a single element per kind and the one definitionContractVersion constant equals it",
  },
  "derived-id-parity": {
    tier: "blocking",
    description:
      "The derived Definition identity in TypeScript and SQL drifting apart: the TypeScript derivation must reproduce the recorded SQL vectors, and the SQL function must be the one they were recorded from",
  },
  "grid-feature-definition": {
    tier: "blocking",
    description:
      "A Records table grid feature key spelled outside its definition file in the grid code, a feature setting group without a default that turns it off, a refusal code without exactly one declared sentence, a featureNotPossible that does not name its file's own refusal, a row-action binding without its compiler gate, or a feature chunk imported outside the UI registry",
  },
  "invalid-guard-allow": {
    tier: "blocking",
    description: "Malformed guard-allow directive or invalid rule id/reason",
  },
  "unused-guard-allow": {
    tier: "blocking",
    description: "A guard-allow directive that matches no finding",
  },
} as const;

export const scannedRuleIds = new Set(
  Object.keys(guardRules).filter(
    (rule) => rule !== "invalid-guard-allow" && rule !== "unused-guard-allow",
  ),
);
