// Change these paths when the repository reaches the target layout.
export const paths = {
  schema: ["contracts/src/", "packages/platform/src/schema/"],
  platform: ["db/src/", "runtime/", "packages/platform/src/"],
  ui: ["ui/src/", "studio/src/", "packages/ui/src/"],
  definitions: ["modules/src/", "packages/definitions/src/"],
  web: ["apps/web/"],
  developmentSetup: [
    "apps/web/scripts/development-setup/",
    "apps/web/scripts/demo-setup/",
    "apps/web/app/_lib/development-setup/",
  ],
  canonical: "supabase/schemas/",
  migrations: "supabase/migrations/",
  applicationSources: "modules/src/",
} as const;

export const packageAreas: Record<string, string> = {
  "@vortex/platform": "platform",
  "@vortex/definitions": "definitions",
  "@vortex/contracts": "schema",
  "@vortex/db": "platform",
  "@vortex/ui": "ui",
  "@vortex/studio": "ui",
  "@vortex/modules": "definitions",
  "@vortex/web": "web",
};
