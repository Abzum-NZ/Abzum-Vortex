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

const setupRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const setupStateRepairInstruction =
  "Run `pnpm demo:setup` to reset the local database, or delete `supabase/.temp/development-setup-state.json`.";
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
const setupStateEnvelopeSchema = z.object({ organizationId: z.uuid() }).passthrough();
const setupStateDocumentSchema = z
  .object({
    organizationId: z.uuid(),
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

const requiredStateEnvelope = (value: unknown) => {
  const parsed = setupStateEnvelopeSchema.safeParse(value);
  if (!parsed.success)
    throw stateFailure(
      "Development setup state has a malformed organisation identity.",
      parsed.error,
    );
  return parsed.data;
};

export const loadSetupState = (
  organizationId: string,
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
  const document = readSetupStateDocument();
  if (document !== undefined) {
    const envelope = requiredStateEnvelope(document);
    if (envelope.organizationId.toLowerCase() === organizationId.toLowerCase()) {
      const parsed = setupStateDocumentSchema.safeParse(document);
      if (!parsed.success)
        throw stateFailure(
          "Development setup state does not match the current schema.",
          parsed.error,
        );
      const stored = parsed.data;
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
            setupCompleted: state.setupCompleted,
            defaultApplicationInitializationAttempted:
              state.defaultApplicationInitializationAttempted,
            defaultApplicationInitializationAttemptRevision:
              state.defaultApplicationInitializationAttemptRevision,
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
