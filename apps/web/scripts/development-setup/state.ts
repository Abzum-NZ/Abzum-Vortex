import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

/**
 * The setup's own record of what it published, kept with the local Supabase database so another
 * worktree using that database reuses its releases instead of creating duplicates.
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
  /** Every application was installed once for this organisation. */
  setupCompleted: boolean;
  /** A default initialization attempt was durably recorded before its protected write. */
  defaultApplicationInitializationAttempted: boolean;
  /** The settings revision observed before the pending default write, or null without one. */
  defaultApplicationInitializationAttemptRevision: number | null;
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

/**
 * The lane a Supabase workdir is, or undefined for any other directory. The lane table lives once,
 * in `tooling/supabase/lane.mjs`; this asks it (`lane.mjs which`) instead of keeping a copy.
 */
export const laneOfWorkdir = (workdir: string): { lane: number } | undefined => {
  const result = spawnSync(
    process.execPath,
    [join(findRepositoryRoot(), "tooling/supabase/lane.mjs"), "which", workdir],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error("lane.mjs which failed: " + String(result.stderr).trim());
  // `null` is the answer for a directory that is not a lane; any failure above is an error.
  return z
    .object({ lane: z.number().int() })
    .nullable()
    .transform((answer) => answer ?? undefined)
    .parse(JSON.parse(result.stdout));
};

const stateFile = (): string =>
  join(
    process.env.VORTEX_SUPABASE_WORKDIR ?? findRepositoryRoot(),
    "supabase",
    ".temp",
    "development-setup-state.json",
  );

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

const setupRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const setupStateRepairInstruction = "Inspect the development setup state for this local database.";
const createdDraftSchema = z
  .object({
    rootId: z.uuid(),
    draftRevision: setupRevisionSchema,
  })
  .strict();
const publishedReleaseSchema = z
  .object({
    rootId: z.uuid(),
    releaseRevision: setupRevisionSchema,
    releaseVersion: z.string().min(1),
  })
  .strict();
const databaseSystemIdSchema = z.string().regex(/^\d+$/);
const setupStateDocumentSchema = z
  .object({
    organizationId: z.uuid(),
    databaseSystemId: databaseSystemIdSchema,
    metadata: developmentSetupMetadataSchema,
    drafts: z.record(z.string(), createdDraftSchema),
    releases: z.record(z.string(), publishedReleaseSchema),
    installerRoleGranted: z.boolean(),
    definitionRoleGranted: z.boolean(),
    setupCompleted: z.boolean(),
    defaultApplicationInitializationAttempted: z.boolean(),
    defaultApplicationInitializationAttemptRevision: setupRevisionSchema.nullable(),
    defaultApplicationInitializationCompleted: z.boolean(),
  })
  .strict()
  .superRefine((state, context) => {
    if (
      (state.defaultApplicationInitializationAttempted &&
        state.defaultApplicationInitializationAttemptRevision === null) ||
      (!state.defaultApplicationInitializationAttempted &&
        state.defaultApplicationInitializationAttemptRevision !== null)
    )
      context.addIssue({
        code: "custom",
        message: "Default initialization attempt metadata is inconsistent.",
      });
  });

const storedStateCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null
    ? Object.getOwnPropertyDescriptor(error, "code")?.value
    : undefined;

const stateFailure = (message: string, cause: unknown): Error => {
  const summary =
    cause instanceof z.ZodError
      ? cause.issues
          .map((issue) => `${issue.path.join(".") || "state"}: ${issue.message}`)
          .join("; ")
      : cause instanceof Error
        ? `${cause.name}${typeof storedStateCode(cause) === "string" ? ` (${String(storedStateCode(cause))})` : ""}: ${cause.message}`
        : typeof cause;
  return new Error(`${message} Cause: ${summary} ${setupStateRepairInstruction}`, { cause });
};

const readSetupStateDocument = (): unknown | undefined => {
  let contents: string;
  try {
    contents = readFileSync(stateFile(), "utf8");
  } catch (error) {
    if (storedStateCode(error) === "ENOENT") return undefined;
    throw stateFailure("Unable to read development setup state.", error);
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    throw stateFailure("Unable to parse development setup state.", error);
  }
};

type StoredSetupState = z.infer<typeof setupStateDocumentSchema>;
let preparedEntries: Record<string, StoredSetupState> | undefined;

/** Validate all stored organisations before provisioning anything into this database. */
export const prepareSetupState = async (
  databaseSystemId: string,
  organizationExists: (organizationId: string) => Promise<boolean>,
): Promise<void> => {
  databaseSystemIdSchema.parse(databaseSystemId);
  const document = readSetupStateDocument();
  const parsed = z.record(z.uuid(), setupStateDocumentSchema).safeParse(document ?? {});
  const lane = process.env.VORTEX_SUPABASE_WORKDIR ?? findRepositoryRoot();
  const selected = laneOfWorkdir(lane);
  const reset = selected
    ? `node tooling/supabase/lane.mjs reset ${selected.lane} .`
    : "reset the selected local database explicitly";
  if (!parsed.success)
    throw stateFailure(
      `Development setup state for ${lane} is old or malformed. Reset with ${reset}.`,
      parsed.error,
    );
  for (const [id, entry] of Object.entries(parsed.data)) {
    if (
      id.toLowerCase() !== entry.organizationId.toLowerCase() ||
      entry.databaseSystemId !== databaseSystemId ||
      !(await organizationExists(id))
    )
      throw new Error(
        `Development setup state for ${lane} is mismatched or orphaned. Reset with ${reset}.`,
      );
  }
  preparedEntries = parsed.data;
};

export const loadSetupState = (
  organizationId: string,
  databaseSystemId: string,
  initialMetadata?: DevelopmentSetupMetadata,
): SetupState => {
  const parsedInitialMetadata =
    initialMetadata === undefined
      ? undefined
      : developmentSetupMetadataSchema.safeParse(initialMetadata);
  if (parsedInitialMetadata !== undefined && !parsedInitialMetadata.success)
    throw stateFailure(
      "Development setup metadata is malformed for the selected organisation.",
      parsedInitialMetadata.error,
    );
  let metadata = parsedInitialMetadata?.success ? parsedInitialMetadata.data : undefined;
  let releases: Record<string, PublishedRelease> = {};
  let drafts: Record<string, CreatedDraft> = {};
  let installerRoleGranted = false;
  let definitionRoleGranted = false;
  let setupCompleted = false;
  let defaultApplicationInitializationAttempted = false;
  let defaultApplicationInitializationAttemptRevision: number | null = null;
  let defaultApplicationInitializationCompleted = false;
  if (preparedEntries === undefined) throw new Error("Development setup state was not prepared.");
  const stored = preparedEntries[organizationId];
  if (stored !== undefined) {
    if (initialMetadata === undefined) metadata = stored.metadata;
    releases = stored.releases;
    drafts = stored.drafts;
    installerRoleGranted = stored.installerRoleGranted;
    definitionRoleGranted = stored.definitionRoleGranted;
    setupCompleted = stored.setupCompleted;
    defaultApplicationInitializationAttempted = stored.defaultApplicationInitializationAttempted;
    defaultApplicationInitializationAttemptRevision =
      stored.defaultApplicationInitializationAttemptRevision;
    defaultApplicationInitializationCompleted = stored.defaultApplicationInitializationCompleted;
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
    setupCompleted,
    defaultApplicationInitializationAttempted,
    defaultApplicationInitializationAttemptRevision,
    defaultApplicationInitializationCompleted,
    save() {
      mkdirSync(dirname(stateFile()), { recursive: true });
      preparedEntries![organizationId] = {
        organizationId: state.organizationId,
        databaseSystemId,
        metadata: state.metadata,
        drafts: state.drafts,
        releases: state.releases,
        installerRoleGranted: state.installerRoleGranted,
        definitionRoleGranted: state.definitionRoleGranted,
        setupCompleted: state.setupCompleted,
        defaultApplicationInitializationAttempted: state.defaultApplicationInitializationAttempted,
        defaultApplicationInitializationAttemptRevision:
          state.defaultApplicationInitializationAttemptRevision,
        defaultApplicationInitializationCompleted: state.defaultApplicationInitializationCompleted,
      };
      writeFileSync(stateFile(), `${JSON.stringify(preparedEntries, null, 2)}\n`);
    },
  };
  return state;
};
