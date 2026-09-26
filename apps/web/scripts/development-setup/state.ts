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
  installerRoleGranted: boolean;
  lifecyclePolicies: Record<string, boolean>;
  rolesGranted: Record<string, boolean>;
  /** Every step, including the initial operating-role grant, completed once for this organisation. */
  setupCompleted: boolean;
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
  let installerRoleGranted = false;
  let lifecyclePolicies: Record<string, boolean> = {};
  let rolesGranted: Record<string, boolean> = {};
  let setupCompleted = false;
  try {
    const stored = JSON.parse(readFileSync(stateFile(), "utf8")) as {
      organizationId?: unknown;
      releases?: Record<string, PublishedRelease>;
      drafts?: Record<string, CreatedDraft>;
      installerRoleGranted?: boolean;
      lifecyclePolicies?: Record<string, boolean>;
      rolesGranted?: Record<string, boolean>;
      setupCompleted?: boolean;
    };
    if (stored.organizationId === organizationId) {
      releases = stored.releases ?? {};
      drafts = stored.drafts ?? {};
      installerRoleGranted = stored.installerRoleGranted === true;
      lifecyclePolicies = stored.lifecyclePolicies ?? {};
      rolesGranted = stored.rolesGranted ?? {};
      setupCompleted = stored.setupCompleted === true;
    }
  } catch {
    // No usable state: start empty.
  }
  const state: SetupState = {
    organizationId,
    drafts,
    releases,
    installerRoleGranted,
    lifecyclePolicies,
    rolesGranted,
    setupCompleted,
    save() {
      mkdirSync(dirname(stateFile()), { recursive: true });
      writeFileSync(
        stateFile(),
        `${JSON.stringify(
          {
            organizationId: state.organizationId,
            drafts: state.drafts,
            releases: state.releases,
            installerRoleGranted: state.installerRoleGranted,
            lifecyclePolicies: state.lifecyclePolicies,
            rolesGranted: state.rolesGranted,
            setupCompleted: state.setupCompleted,
          },
          null,
          2,
        )}\n`,
      );
    },
  };
  return state;
};
