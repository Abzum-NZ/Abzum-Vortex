import { existsSync } from "node:fs";
import { join } from "node:path";
import { findRepositoryRoot } from "../development-setup/state";

/** Loads the same local environment files Next.js reads, while preserving shell overrides. */
export const loadLocalWebEnvironment = (): void => {
  const appDirectory = join(findRepositoryRoot(), "apps", "web");
  for (const name of [".env.development.local", ".env.local", ".env.development", ".env"]) {
    const path = join(appDirectory, name);
    if (existsSync(path)) process.loadEnvFile(path);
  }
};
