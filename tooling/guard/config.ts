export const paths = {
  schema: ["packages/platform/src/schema.ts"],
  platform: ["packages/platform/src/"],
  ui: ["packages/ui/src/"],
  definitions: ["packages/definitions/src/"],
  web: ["apps/web/"],
  developmentSetup: [
    "apps/web/scripts/development-setup/",
    "apps/web/scripts/demo-setup/",
    "apps/web/app/_lib/development-setup/",
  ],
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
    tier: "warning",
    owner: "lead",
    reviewBy: "2026-11-15",
    reviewNote: "Decide canonical coverage after the migration baseline review",
    description: "Latest migrated SQL functions without canonical definitions",
  },
  "function-uuid": {
    tier: "blocking",
    owner: "lead",
    reviewBy: "2027-01-15",
    description: "Hard-coded non-nil UUIDs in SQL functions",
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
  "file-size": {
    tier: "warning",
    owner: "lead",
    reviewBy: "2026-11-15",
    reviewNote: "Reconsider after #2235",
    description: "Source files over 1,500 lines",
  },
  "unused-file": {
    tier: "warning",
    owner: "lead",
    reviewBy: "2026-11-15",
    reviewNote: "Reconsider after #2235",
    description: "Files reported unused by Knip",
  },
  "unused-export": {
    tier: "warning",
    owner: "lead",
    reviewBy: "2026-11-15",
    reviewNote: "Reconsider after #2235",
    description: "Exports reported unused by Knip",
  },
  "unused-dependency": {
    tier: "warning",
    owner: "lead",
    reviewBy: "2026-11-15",
    reviewNote: "Reconsider after #2235",
    description: "Dependencies reported unused by Knip",
  },
  "process-artifact": {
    tier: "warning",
    owner: "lead",
    reviewBy: "2026-11-15",
    reviewNote: "Expires when #2238 merges",
    description: "Process-only receipt, fingerprint, continuity, or evidence artefacts",
  },
  "silent-parse": {
    tier: "warning",
    owner: "lead",
    reviewBy: "2027-01-15",
    description: "Silent handling of a failed safeParse result",
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
  "stale-baseline": {
    tier: "warning",
    owner: "lead",
    reviewBy: "2027-01-15",
    description: "A blocking baseline entry with no current finding",
  },
  "baseline-growth": {
    tier: "blocking",
    owner: "lead",
    reviewBy: "2027-01-15",
    description: "A blocking baseline entry added outside the main tree",
  },
} as const;

export const scannedRuleIds = new Set([
  "business-name",
  "layering",
  "migration-mismatch",
  "migration-orphan",
  "function-uuid",
  "versioned-export",
  "versioned-file",
  "file-size",
  "unused-file",
  "unused-export",
  "unused-dependency",
  "process-artifact",
  "silent-parse",
]);
