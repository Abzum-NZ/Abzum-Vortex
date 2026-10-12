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
