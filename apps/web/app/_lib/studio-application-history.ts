import "server-only";

import { z } from "zod";
import {
  createBuilderAuthority,
  type BuilderTargetFactsReader,
  readBuilderApplicationOrigin,
} from "@vortex/platform/server";
import {
  applicationRootIdSchema,
  canonicalJson,
  correlationIdSchema,
  definitionReleaseMetadataSchema,
  describeFailure,
  fingerprintSchema,
  namespacedKeySchema,
  organizationIdSchema,
  asRecord,
  countSourceChange,
  summarizeSourceChange,
  type ApplicationSourceDocument,
  type SourceChangeCount,
  type SourceChangeRow,
  revisionSchema,
  sameId,
  type DefinitionReleaseMetadata,
  type StoredDefinitionDraft,
} from "@vortex/platform/schema";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/platform/server";
import {
  assertBeforeLiveDeadline,
  assertLivePermission,
  BuilderAuthorityError,
  platformOrganizationPermissionDeclaration,
  readApplicationDefinitionDraft,
  readLiveHumanContext,
  readVisiblePersonLabels,
  requireBuilderAuthority,
  type LiveHumanContext,
} from "@vortex/platform/server";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { humanOrganizationRequests } from "./server-composition";
import { DefinitionError, classifyDatabaseError } from "@vortex/platform/server";
import { platformPermissionSource } from "./platform-permission-source";

/** Versions per page: the default of the paging rule. */
const pageSize = 40;
const snapshotFields = {
  draftRevision: revisionSchema,
  sourceFingerprint: fingerprintSchema,
  anchorReleaseRevision: revisionSchema.nullable(),
};
const expectedSnapshotSchema = z.object(snapshotFields).strict();
const snapshotSchema = z
  .object({
    organizationId: organizationIdSchema,
    rootId: applicationRootIdSchema,
    definitionKey: namespacedKeySchema,
    ...snapshotFields,
    correlationId: correlationIdSchema,
  })
  .strict();

export type StudioApplicationHistorySnapshot = z.infer<typeof snapshotSchema>;
export type StudioApplicationHistoryFailure = Readonly<{
  kind: "refused" | "conflict" | "temporarily_unavailable";
  /** The stable code logged on the server and mapped to a message for the person. */
  reason: string;
}>;
/** What a version changed against the one before it, counted by area; the sources stay on the server. */
export type StudioReleaseChanges =
  | Readonly<{ kind: "first" }>
  | Readonly<{ kind: "changed"; counts: readonly SourceChangeCount[] }>
  /** A version published in an earlier source format cannot be compared. */
  | Readonly<{ kind: "unavailable" }>;
export type StudioApplicationReleaseEntry = DefinitionReleaseMetadata &
  Readonly<{ changes: StudioReleaseChanges }>;
export type StudioApplicationHistoryPage = Readonly<{
  snapshot: StudioApplicationHistorySnapshot;
  /** Newest first. */
  entries: readonly StudioApplicationReleaseEntry[];
  /** The names of the people who published the entries, by lowercase account id, as far as the viewer may see them. */
  publishers: Readonly<Record<string, string>>;
  /** A platform application's versions are published by the platform, not by a person in this directory. */
  isSystemApplication: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
}>;
export type StudioApplicationReleaseChangesResult =
  | StudioApplicationHistoryFailure
  | Readonly<{
      kind: "available";
      /** True for the first version, which has nothing to compare with. */
      first: boolean;
      /** False for a version published in an earlier source format. */
      comparable: boolean;
      rows: readonly SourceChangeRow[];
    }>;
export type StudioApplicationHistoryListResult =
  | StudioApplicationHistoryFailure
  | Readonly<{ kind: "available"; page: StudioApplicationHistoryPage }>;

type Draft = Extract<StoredDefinitionDraft, { kind: "application" }>;
type ExpectedSnapshot = z.infer<typeof expectedSnapshotSchema>;
class HistoryRefused extends Error {}
class HistoryConflict extends Error {}
class HistoryStorageUnavailable extends Error {}
/** The root does not exist, is foreign to this organization or is not an application: the classifier answers one `unavailable`. */
class HistoryRootMissing extends Error {}

const targetFacts: BuilderTargetFactsReader = async (transaction, _scope, rootId) => {
  if (rootId === undefined) throw new HistoryRefused();
  const origin = await readBuilderApplicationOrigin(transaction, rootId);
  if (origin === undefined) throw new HistoryRootMissing();
  return { isSystemApplication: origin === "platform_system_application" };
};

/** A live draft-management decision and database clock fence the complete safe projection. */
const assertLiveCompletion = async (
  transaction: RequestDatabaseTransaction,
  context: LiveHumanContext,
  entries: readonly DefinitionReleaseMetadata[],
): Promise<void> => {
  const decision = await assertLivePermission(
    transaction,
    platformOrganizationPermissionDeclaration(
      platformPermissionSource,
      "platform.organization.definition_drafts.manage",
    ),
    context,
  );
  const now = await assertBeforeLiveDeadline(
    transaction,
    Math.min(Date.parse(context.expiresAt), decision.validUntil),
  );
  if (entries.some((entry) => Date.parse(entry.publishedAt) > now))
    throw new HistoryStorageUnavailable();
};

/** One log line with the stable reason code and, when there is one, the cause. */
const declined = (
  failure: StudioApplicationHistoryFailure,
  error?: unknown,
): StudioApplicationHistoryFailure => {
  console.error(
    `[studio] application history ${failure.kind} reason=${failure.reason}` +
      (error === undefined ? "" : ` cause=${describeFailure(error)}`),
  );
  return failure;
};

const safeFailure = (error: unknown): StudioApplicationHistoryFailure => {
  if (error instanceof HistoryConflict || classifyDatabaseError(error) === "conflict")
    return declined({ kind: "conflict", reason: "draft_changed" }, error);
  if (error instanceof DefinitionError && error.code === "DEFINITION_DRAFT_STALE_OR_MISSING")
    return declined({ kind: "conflict", reason: "draft_changed" }, error);
  if (error instanceof HistoryRootMissing)
    return declined({ kind: "refused", reason: "draft_missing" }, error);
  if (error instanceof BuilderAuthorityError)
    return declined(
      {
        kind: "refused",
        reason:
          error.code === "BUILDER_RECENT_AUTHENTICATION_REQUIRED"
            ? "recent_authentication_required"
            : "permission_missing",
      },
      error,
    );
  if (error instanceof DefinitionError && error.code === "DEFINITION_ROOT_MISSING")
    return declined({ kind: "refused", reason: "draft_missing" }, error);
  if (
    error instanceof HistoryRefused ||
    classifyDatabaseError(error) === "refused" ||
    (error instanceof DefinitionError &&
      ["DEFINITION_CONTEXT_REFUSED", "INVALID_DEFINITION_COMMAND"].includes(error.code))
  )
    return declined({ kind: "refused", reason: "context_changed" }, error);
  return declined({ kind: "temporarily_unavailable", reason: "request_failed" }, error);
};

/** Returning available waits for the original transaction to complete normally. */
const executeRead = async <Value>(
  candidateOrganizationId: string,
  candidateRootId: string,
  expected: ExpectedSnapshot | undefined,
  read: (
    transaction: RequestDatabaseTransaction,
    draft: Draft,
    snapshot: StudioApplicationHistorySnapshot,
  ) => Promise<
    Readonly<{
      value: Value;
      metadata: readonly DefinitionReleaseMetadata[];
    }>
  >,
): Promise<StudioApplicationHistoryFailure | Readonly<{ kind: "available"; value: Value }>> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const root = applicationRootIdSchema.safeParse(candidateRootId);
  if (!organization.success || !root.success)
    return declined({ kind: "refused", reason: "request_invalid" });
  let failure: StudioApplicationHistoryFailure | undefined;
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active")
      return declined(
        resolved.kind === "temporarily_unavailable"
          ? { kind: "temporarily_unavailable", reason: "session_unavailable" }
          : { kind: "refused", reason: "session_ended" },
      );
    const result = await humanOrganizationRequests().run(
      resolved.session,
      { organizationId: organization.data },
      async (transaction, scope, issuedAt): Promise<Value> => {
        try {
          if (!sameId(scope.organizationId, organization.data)) throw new HistoryRefused();
          const context = await readLiveHumanContext(transaction, {
            scope,
            session: resolved.session,
            issuedAt,
          });
          const authority = createBuilderAuthority({
            transaction,
            scope,
            targetFacts,
            permissions: platformPermissionSource,
          });
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId: root.data });
          const draft = await readApplicationDefinitionDraft(transaction, scope, {
            rootId: root.data,
          });
          const anchor = draft.publishedRevision ?? null;
          if (
            expected !== undefined &&
            (draft.draftRevision !== expected.draftRevision ||
              draft.sourceFingerprint !== expected.sourceFingerprint ||
              anchor !== expected.anchorReleaseRevision)
          )
            throw new HistoryConflict();
          const snapshot = snapshotSchema.parse({
            organizationId: scope.organizationId,
            rootId: draft.rootId,
            definitionKey: draft.key,
            draftRevision: draft.draftRevision,
            sourceFingerprint: draft.sourceFingerprint,
            anchorReleaseRevision: anchor,
            correlationId: context.correlationId,
          });
          const output = await read(transaction, draft, snapshot);
          const final = await readApplicationDefinitionDraft(transaction, scope, {
            rootId: root.data,
            expectedDraftRevision: draft.draftRevision,
          });
          if (canonicalJson(final) !== canonicalJson(draft)) throw new HistoryConflict();
          await targetFacts(transaction, scope, root.data);
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId: root.data });
          const completion = await readLiveHumanContext(transaction, {
            scope,
            session: resolved.session,
            issuedAt,
          });
          if (canonicalJson(completion) !== canonicalJson(context)) throw new HistoryRefused();
          await assertLiveCompletion(transaction, completion, output.metadata);
          return output.value;
        } catch (error) {
          failure = safeFailure(error);
          // Even expected refusals and conflicts leave through the original transaction.
          throw error;
        }
      },
    );
    if (result.kind === "available") return { kind: "available", value: result.value };
    return (
      failure ??
      declined(
        result.kind === "unavailable"
          ? { kind: "refused", reason: "organization_unavailable" }
          : { kind: "temporarily_unavailable", reason: "request_failed" },
      )
    );
  } catch (error) {
    return failure ?? safeFailure(error);
  }
};

const listRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("newest"), rootId: applicationRootIdSchema }).strict(),
  z
    .object({
      kind: z.enum(["older", "newer"]),
      rootId: applicationRootIdSchema,
      expected: expectedSnapshotSchema,
      /** The oldest version shown (to read older) or the newest shown (to read newer). */
      cursorReleaseRevision: revisionSchema,
    })
    .strict(),
]);
const changesRequestSchema = z
  .object({
    rootId: applicationRootIdSchema,
    expected: expectedSnapshotSchema,
    releaseRevision: revisionSchema,
  })
  .strict();

const sourceEntrySchema = z
  .object({
    releaseRevision: revisionSchema,
    releaseVersion: z.string(),
    publishedAt: z.string(),
    publishedBy: z.string(),
    releaseNote: z.string(),
    authoredSourceFingerprint: fingerprintSchema,
    authoredSource: z.unknown(),
    previousReleaseRevision: revisionSchema.nullable(),
  })
  .strict();
const pageSchema = z
  .object({
    anchorReleaseRevision: revisionSchema,
    entries: z.array(sourceEntrySchema).max(200),
    predecessor: z
      .object({ releaseRevision: revisionSchema, authoredSource: z.unknown() })
      .strict()
      .nullable(),
    hasOlder: z.boolean(),
    hasNewer: z.boolean(),
  })
  .strict();
type PageRows = z.infer<typeof pageSchema>;

/** A stored source is compared by its body; one that has none (an earlier format) cannot be. */
const comparableSource = (value: unknown): ApplicationSourceDocument | undefined => {
  const body = asRecord(asRecord(value)?.body);
  return body === undefined ? undefined : (value as ApplicationSourceDocument);
};

/** The source of the version an entry follows: another entry of the page, or the one just older. */
const previousSourceOf = (
  page: PageRows,
  entry: PageRows["entries"][number],
): ApplicationSourceDocument | undefined => {
  if (entry.previousReleaseRevision === null) return undefined;
  const inPage = page.entries.find(
    (candidate) => candidate.releaseRevision === entry.previousReleaseRevision,
  );
  if (inPage !== undefined) return comparableSource(inPage.authoredSource);
  if (page.predecessor?.releaseRevision === entry.previousReleaseRevision)
    return comparableSource(page.predecessor.authoredSource);
  throw new HistoryStorageUnavailable();
};

/** One newest-first page of versions with the sources the change summary compares; the compilation output is never read. */
const readPage = async (
  transaction: RequestDatabaseTransaction,
  rootId: string,
  anchor: number,
  cursor: number | null,
  direction: "older" | "newer",
  size: number,
): Promise<PageRows> => {
  const rows = await transaction.query<DatabaseRow>`
    select vortex_definition.read_application_release_history_page(
      ${rootId}::uuid, ${anchor}::bigint, ${cursor}::bigint, ${direction}::text, ${size}::integer
    ) as release_history_page
  `;
  const parsed = pageSchema.safeParse(rows[0]?.release_history_page);
  if (
    rows.length !== 1 ||
    !parsed.success ||
    parsed.data.anchorReleaseRevision !== anchor ||
    parsed.data.entries.length > size
  ) {
    console.error(
      "[studio] release history page was not readable",
      parsed.success ? "" : describeFailure(parsed.error),
    );
    throw new HistoryStorageUnavailable();
  }
  const page = parsed.data;
  let previous = Number.POSITIVE_INFINITY;
  for (const entry of page.entries) {
    if (entry.releaseRevision >= previous || entry.releaseRevision > anchor)
      throw new HistoryStorageUnavailable();
    previous = entry.releaseRevision;
  }
  return page;
};

const entryMetadata = (
  entry: PageRows["entries"][number],
  anchor: number,
): DefinitionReleaseMetadata => {
  const metadata = definitionReleaseMetadataSchema.safeParse({
    releaseRevision: entry.releaseRevision,
    releaseVersion: entry.releaseVersion,
    sourceFingerprint: entry.authoredSourceFingerprint,
    releaseNote: entry.releaseNote,
    publishedAt: entry.publishedAt,
    publishedBy: entry.publishedBy,
    isCurrent: entry.releaseRevision === anchor,
  });
  if (!metadata.success) throw new HistoryStorageUnavailable();
  return metadata.data;
};

/** What one version changed against the one before it, counted by area. */
const changesOf = (page: PageRows, entry: PageRows["entries"][number]): StudioReleaseChanges => {
  if (entry.previousReleaseRevision === null) return { kind: "first" };
  const before = previousSourceOf(page, entry);
  const after = comparableSource(entry.authoredSource);
  if (before === undefined || after === undefined) return { kind: "unavailable" };
  return { kind: "changed", counts: countSourceChange(summarizeSourceChange(before, after)) };
};

export const listStudioApplicationReleaseHistory = async (
  organizationId: string,
  candidate: unknown,
): Promise<StudioApplicationHistoryListResult> => {
  const request = listRequestSchema.safeParse(candidate);
  if (!request.success) return declined({ kind: "refused", reason: "request_invalid" });
  const command = request.data;
  if (
    command.kind !== "newest" &&
    (command.expected.anchorReleaseRevision === null ||
      command.cursorReleaseRevision > command.expected.anchorReleaseRevision)
  )
    return declined({ kind: "refused", reason: "request_invalid" });
  const result = await executeRead(
    organizationId,
    command.rootId,
    command.kind === "newest" ? undefined : command.expected,
    async (transaction, _draft, snapshot) => {
      const anchor = snapshot.anchorReleaseRevision;
      const page: PageRows | null =
        anchor === null
          ? null
          : await readPage(
              transaction,
              snapshot.rootId,
              anchor,
              command.kind === "newest" ? null : command.cursorReleaseRevision,
              command.kind === "newer" ? "newer" : "older",
              pageSize,
            );
      const entries: readonly StudioApplicationReleaseEntry[] =
        page === null || anchor === null
          ? []
          : page.entries.map((entry) => ({
              ...entryMetadata(entry, anchor),
              changes: changesOf(page, entry),
            }));
      // Who published each version, read in the same request with the viewer's own directory access.
      const authors = [...new Set(entries.map((entry) => entry.publishedBy.toLowerCase()))];
      const names =
        authors.length === 0
          ? new Map<string, string>()
          : await readVisiblePersonLabels(transaction, authors);
      return {
        value: {
          snapshot,
          entries,
          hasOlder: page?.hasOlder ?? false,
          hasNewer: page?.hasNewer ?? false,
          publishers: Object.fromEntries(names),
          isSystemApplication:
            (await readBuilderApplicationOrigin(transaction, snapshot.rootId)) ===
            "platform_system_application",
        },
        metadata: entries,
      };
    },
  );
  return result.kind === "available" ? { kind: "available", page: result.value } : result;
};

/** The rows of what one version changed against the one before it, for the View changes sheet. */
export const readStudioApplicationReleaseChanges = async (
  organizationId: string,
  candidate: unknown,
): Promise<StudioApplicationReleaseChangesResult> => {
  const request = changesRequestSchema.safeParse(candidate);
  const anchor = request.success ? request.data.expected.anchorReleaseRevision : null;
  if (!request.success || anchor === null || request.data.releaseRevision > anchor)
    return declined({ kind: "refused", reason: "request_invalid" });
  const command = request.data;
  const result = await executeRead(
    organizationId,
    command.rootId,
    command.expected,
    async (transaction, _draft, snapshot) => {
      // The version and the one just older than it: a page of one that ends at the version.
      const page = await readPage(
        transaction,
        snapshot.rootId,
        anchor,
        command.releaseRevision + 1,
        "older",
        1,
      );
      const entry = page.entries[0];
      if (entry === undefined || entry.releaseRevision !== command.releaseRevision)
        throw new HistoryRefused();
      const before = previousSourceOf(page, entry);
      const after = comparableSource(entry.authoredSource);
      const first = entry.previousReleaseRevision === null;
      const comparable = first || (before !== undefined && after !== undefined);
      return {
        value: {
          first,
          // A version published in an earlier source format cannot be compared: the sheet says so.
          comparable,
          rows:
            before === undefined || after === undefined ? [] : summarizeSourceChange(before, after),
        },
        metadata: [entryMetadata(entry, anchor)],
      };
    },
  );
  return result.kind === "available" ? { kind: "available", ...result.value } : result;
};
