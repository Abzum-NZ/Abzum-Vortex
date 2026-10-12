import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

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

export type DevelopmentSetupMetadata = Readonly<{
  tenantId: string;
  tenantShortName: string;
  organizationShortName: string;
  accessVersion: number;
  systemActorId: string;
  stewardIdentityId: string;
  stewardOrganizationAccountId: string;
}>;

export type SetupState = {
  organizationId: string;
  metadata: DevelopmentSetupMetadata;
  drafts: Record<string, CreatedDraft>;
  releases: Record<string, PublishedRelease>;
  installerRoleGranted: boolean;
  definitionRoleGranted: boolean;
  lifecyclePolicies: Record<string, boolean>;
  /**
   * Organisation-shared record types whose one lifecycle policy is stored, by storage contract id.
   * Every application that binds the owning module needs it, but only the first stores it.
   */
  sharedLifecyclePolicies: Record<string, boolean>;
  /** Every application was installed once for this organisation. */
  setupCompleted: boolean;
  /** A default initialization attempt was durably recorded before its protected write. */
  defaultApplicationInitializationAttempted: boolean;
  /** The one-time default initialization decision has been handled for this organisation. */
  defaultApplicationInitializationCompleted: boolean;
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

const developmentSetupMetadataSchema = z
  .object({
    tenantId: z.uuid(),
    tenantShortName: z.string().min(1),
    organizationShortName: z.string().min(1),
    accessVersion: z.number().int().nonnegative(),
    systemActorId: z.uuid(),
    stewardIdentityId: z.uuid(),
    stewardOrganizationAccountId: z.uuid(),
  })
  .strict();

export const loadSetupState = (
  organizationId: string,
  initialMetadata?: DevelopmentSetupMetadata,
): SetupState => {
  let metadata = initialMetadata;
  let releases: Record<string, PublishedRelease> = {};
  let drafts: Record<string, CreatedDraft> = {};
  let installerRoleGranted = false;
  let definitionRoleGranted = false;
  let lifecyclePolicies: Record<string, boolean> = {};
  let sharedLifecyclePolicies: Record<string, boolean> = {};
  let setupCompleted = false;
  let defaultApplicationInitializationAttempted = false;
  let defaultApplicationInitializationCompleted = false;
  try {
    const stored = JSON.parse(readFileSync(stateFile(), "utf8")) as {
      organizationId?: unknown;
      metadata?: unknown;
      releases?: Record<string, PublishedRelease>;
      drafts?: Record<string, CreatedDraft>;
      installerRoleGranted?: boolean;
      definitionRoleGranted?: boolean;
      lifecyclePolicies?: Record<string, boolean>;
      sharedLifecyclePolicies?: Record<string, boolean>;
      setupCompleted?: boolean;
      defaultApplicationInitializationAttempted?: boolean;
      defaultApplicationInitializationCompleted?: boolean;
    };
    if (stored.organizationId === organizationId) {
      if (initialMetadata === undefined) {
        const parsedMetadata = developmentSetupMetadataSchema.safeParse(stored.metadata);
        if (parsedMetadata.success) metadata = parsedMetadata.data;
      }
      releases = stored.releases ?? {};
      drafts = stored.drafts ?? {};
      installerRoleGranted = stored.installerRoleGranted === true;
      definitionRoleGranted = stored.definitionRoleGranted === true;
      lifecyclePolicies = stored.lifecyclePolicies ?? {};
      sharedLifecyclePolicies = stored.sharedLifecyclePolicies ?? {};
      setupCompleted = stored.setupCompleted === true;
      if (
        typeof stored.defaultApplicationInitializationAttempted === "boolean" &&
        typeof stored.defaultApplicationInitializationCompleted === "boolean"
      ) {
        defaultApplicationInitializationAttempted =
          stored.defaultApplicationInitializationAttempted;
        defaultApplicationInitializationCompleted =
          stored.defaultApplicationInitializationCompleted;
      } else {
        // An existing setup predates this marker. Its null default may be an explicit clear,
        // so upgrading must preserve that choice rather than guessing it was never initialized.
        defaultApplicationInitializationCompleted = true;
      }
    }
  } catch {
    // No usable state: start empty.
  }
  if (metadata === undefined)
    throw new Error("Development setup metadata is unavailable for the selected organisation.");
  const state: SetupState = {
    organizationId,
    metadata,
    drafts,
    releases,
    installerRoleGranted,
    definitionRoleGranted,
    lifecyclePolicies,
    sharedLifecyclePolicies,
    setupCompleted,
    defaultApplicationInitializationAttempted,
    defaultApplicationInitializationCompleted,
    save() {
      mkdirSync(dirname(stateFile()), { recursive: true });
      writeFileSync(
        stateFile(),
        `${JSON.stringify(
          {
            organizationId: state.organizationId,
            metadata: state.metadata,
            drafts: state.drafts,
            releases: state.releases,
            installerRoleGranted: state.installerRoleGranted,
            definitionRoleGranted: state.definitionRoleGranted,
            lifecyclePolicies: state.lifecyclePolicies,
            sharedLifecyclePolicies: state.sharedLifecyclePolicies,
            setupCompleted: state.setupCompleted,
            defaultApplicationInitializationAttempted:
              state.defaultApplicationInitializationAttempted,
            defaultApplicationInitializationCompleted:
              state.defaultApplicationInitializationCompleted,
          },
          null,
          2,
        )}\n`,
      );
    },
  };
  return state;
};

/** Loads the most recently set up organisation for the standalone idempotent demo seeder. */
export const loadCurrentSetupState = (): SetupState => {
  const stored = JSON.parse(readFileSync(stateFile(), "utf8")) as { organizationId?: unknown };
  const organizationId = z.uuid().parse(stored.organizationId);
  return loadSetupState(organizationId);
};
