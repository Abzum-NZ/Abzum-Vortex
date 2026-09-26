import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The setup's own record of what it published, kept in the ignored `supabase/.temp` directory so a
 * re-run reuses the releases instead of creating duplicates. It holds identifiers only and is
 * discarded when it belongs to another organisation (a reset database creates a new one).
 */

export type PublishedRelease = Readonly<{
  rootId: string;
  releaseRevision: number;
  releaseVersion: string;
}>;

export type SetupState = {
  organizationId: string;
  releases: Record<string, PublishedRelease>;
  save(): void;
};

export const findRepositoryRoot = (start = process.cwd()): string => {
  let directory = resolve(start);
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Run the setup from inside the Vortex repository.");
    directory = parent;
  }
};

const stateFile = (): string =>
  join(findRepositoryRoot(), "supabase", ".temp", "development-setup-state.json");

export const loadSetupState = (organizationId: string): SetupState => {
  let releases: Record<string, PublishedRelease> = {};
  try {
    const stored = JSON.parse(readFileSync(stateFile(), "utf8")) as {
      organizationId?: unknown;
      releases?: Record<string, PublishedRelease>;
    };
    if (stored.organizationId === organizationId && stored.releases !== undefined)
      releases = stored.releases;
  } catch {
    // No usable state: start empty.
  }
  const state: SetupState = {
    organizationId,
    releases,
    save() {
      mkdirSync(dirname(stateFile()), { recursive: true });
      writeFileSync(
        stateFile(),
        `${JSON.stringify({ organizationId: state.organizationId, releases: state.releases }, null, 2)}\n`,
      );
    },
  };
  return state;
};
