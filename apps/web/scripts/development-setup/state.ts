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

/** A draft root created but not yet published, so an interrupted run resumes instead of repeating. */
export type CreatedDraft = Readonly<{ rootId: string; draftRevision: number }>;

export type SetupState = {
  organizationId: string;
  drafts: Record<string, CreatedDraft>;
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
  let drafts: Record<string, CreatedDraft> = {};
  try {
    const stored = JSON.parse(readFileSync(stateFile(), "utf8")) as {
      organizationId?: unknown;
      releases?: Record<string, PublishedRelease>;
      drafts?: Record<string, CreatedDraft>;
    };
    if (stored.organizationId === organizationId) {
      releases = stored.releases ?? {};
      drafts = stored.drafts ?? {};
    }
  } catch {
    // No usable state: start empty.
  }
  const state: SetupState = {
    organizationId,
    drafts,
    releases,
    save() {
      mkdirSync(dirname(stateFile()), { recursive: true });
      writeFileSync(
        stateFile(),
        `${JSON.stringify(
          { organizationId: state.organizationId, drafts: state.drafts, releases: state.releases },
          null,
          2,
        )}\n`,
      );
    },
  };
  return state;
};
