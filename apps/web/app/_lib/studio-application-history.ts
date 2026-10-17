import "server-only";

import { z } from "zod";
import { createBuilderAuthority, type BuilderTargetFactsReader } from "@vortex/platform/server";
import {
  applicationRootIdSchema, canonicalJson, correlationIdSchema, definitionReleaseMetadataSchema, describeFailure, fingerprintSchema, namespacedKeySchema,
  organizationIdSchema,
  publishedApplicationReferenceSchema, revisionSchema, sameId,
  type DefinitionReleaseMetadata,
  type StoredDefinitionDraft,
} from "@vortex/platform/schema";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/platform/server";
import { assertBeforeLiveDeadline, assertLivePermission, BuilderAuthorityError,
  platformOrganizationPermissionDeclaration, readApplicationDefinitionDraft, readLiveHumanContext, readVisiblePersonLabels,
  requireBuilderAuthority, type LiveHumanContext } from "@vortex/platform/server";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { humanOrganizationRequests } from "./server-composition";
import { DefinitionError, classifyDatabaseError } from "@vortex/platform/server";
import { platformPermissionSource } from "./platform-permission-source";

const pageSize = 20;
const snapshotFields = {
  draftRevision: revisionSchema,
  sourceFingerprint: fingerprintSchema,
  anchorReleaseRevision: revisionSchema.nullable(),
};
const expectedSnapshotSchema = z.object(snapshotFields).strict();
const snapshotSchema = z.object({
  organizationId: organizationIdSchema, rootId: applicationRootIdSchema,
  definitionKey: namespacedKeySchema, ...snapshotFields, correlationId: correlationIdSchema,
}).strict();
const listRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reload"), rootId: applicationRootIdSchema }).strict(),
  z.object({ kind: z.literal("next"), rootId: applicationRootIdSchema,
    expected: expectedSnapshotSchema, afterReleaseRevision: revisionSchema }).strict(),
]);
const pageSchema = z.object({
  anchorReleaseRevision: revisionSchema,
  entries: z.array(z.object({
    previousReleaseRevision: revisionSchema.nullable(),
    release: z.object({
      publication: publishedApplicationReferenceSchema,
      releaseNote: z.string(),
      // The protected producer includes compilation evidence. Only this fingerprint is projected.
      evidence: z.object({ authoredSourceFingerprint: fingerprintSchema }).passthrough(),
    }).passthrough(),
  }).strict()).min(1).max(pageSize),
  nextAfterReleaseRevision: revisionSchema.nullable(),
}).strict();

export type StudioApplicationHistorySnapshot = z.infer<typeof snapshotSchema>;
export type StudioApplicationHistoryFailure = Readonly<{
  kind: "refused" | "conflict" | "temporarily_unavailable";
  /** The stable code logged on the server and mapped to a message for the person. */
  reason: string;
}>;
export type StudioApplicationHistoryPage = Readonly<{
  snapshot: StudioApplicationHistorySnapshot;
  entries: readonly DefinitionReleaseMetadata[];
  /** The names of the people who published the entries, by lowercase account id, as far as the viewer may see them. */
  publishers: Readonly<Record<string, string>>;
  nextAfterReleaseRevision: number | null;
}>;
export type StudioApplicationHistoryListResult = StudioApplicationHistoryFailure |
  Readonly<{ kind: "available"; page: StudioApplicationHistoryPage }>;

type Draft = Extract<StoredDefinitionDraft, { kind: "application" }>;
type ExpectedSnapshot = z.infer<typeof expectedSnapshotSchema>;
class HistoryRefused extends Error {}
class HistoryConflict extends Error {}
class HistoryStorageUnavailable extends Error {}
/** The root does not exist, is foreign to this organization or is not an application: the classifier answers one `unavailable`. */
class HistoryRootMissing extends Error {}

const targetFacts: BuilderTargetFactsReader = async (transaction, _scope, rootId) => {
  if (rootId === undefined) throw new HistoryRefused();
  const rows = await transaction.query<DatabaseRow>`
    select outcome, application_origin_kind
    from vortex_definition.read_builder_application_root_classification(${rootId}::uuid)
  `;
  if (rows.length === 1 && rows[0]?.outcome === "unavailable") throw new HistoryRootMissing();
  if (rows.length !== 1 || rows[0]?.outcome !== "available" ||
    rows[0]?.application_origin_kind !== "ordinary") throw new HistoryRefused();
  return { isSystemApplication: false };
};

/** A live draft-management decision and database clock fence the complete safe projection. */
const assertLiveCompletion = async (
  transaction: RequestDatabaseTransaction, context: LiveHumanContext,
  entries: readonly DefinitionReleaseMetadata[],
): Promise<void> => {
  const decision = await assertLivePermission(transaction,
    platformOrganizationPermissionDeclaration(
      platformPermissionSource,
      "platform.organization.definition_drafts.manage",
    ), context);
  const now = await assertBeforeLiveDeadline(transaction,
    Math.min(Date.parse(context.expiresAt), decision.validUntil));
  if (entries.some((entry) => Date.parse(entry.publishedAt) > now))
    throw new HistoryStorageUnavailable();
};

/** One log line with the stable reason code and, when there is one, the cause. */
const declined = (failure: StudioApplicationHistoryFailure, error?: unknown): StudioApplicationHistoryFailure => {
  console.error(`[studio] application history ${failure.kind} reason=${failure.reason}` +
    (error === undefined ? "" : ` cause=${describeFailure(error)}`));
  return failure;
};

const safeFailure = (error: unknown): StudioApplicationHistoryFailure => {
  if (error instanceof HistoryConflict ||
    classifyDatabaseError(error) === "conflict")
    return declined({ kind: "conflict", reason: "draft_changed" }, error);
  if (error instanceof DefinitionError && error.code === "DEFINITION_DRAFT_STALE_OR_MISSING")
    return declined({ kind: "conflict", reason: "draft_changed" }, error);
  if (error instanceof HistoryRootMissing)
    return declined({ kind: "refused", reason: "draft_missing" }, error);
  if (error instanceof BuilderAuthorityError)
    return declined({ kind: "refused", reason: error.code === "BUILDER_RECENT_AUTHENTICATION_REQUIRED"
      ? "recent_authentication_required" : "permission_missing" }, error);
  if (error instanceof DefinitionError && error.code === "DEFINITION_ROOT_MISSING")
    return declined({ kind: "refused", reason: "draft_missing" }, error);
  if (error instanceof HistoryRefused ||
    classifyDatabaseError(error) === "refused" ||
    (error instanceof DefinitionError && ["DEFINITION_CONTEXT_REFUSED", "INVALID_DEFINITION_COMMAND"].includes(error.code)))
    return declined({ kind: "refused", reason: "context_changed" }, error);
  return declined({ kind: "temporarily_unavailable", reason: "request_failed" }, error);
};

/** Returning available waits for the original transaction to complete normally. */
const executeRead = async <Value>(
  candidateOrganizationId: string, candidateRootId: string, expected: ExpectedSnapshot | undefined,
  read: (transaction: RequestDatabaseTransaction, draft: Draft,
    snapshot: StudioApplicationHistorySnapshot) => Promise<Readonly<{
      value: Value; metadata: readonly DefinitionReleaseMetadata[];
    }>>,
): Promise<StudioApplicationHistoryFailure | Readonly<{ kind: "available"; value: Value }>> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const root = applicationRootIdSchema.safeParse(candidateRootId);
  if (!organization.success || !root.success) return declined({ kind: "refused", reason: "request_invalid" });
  let failure: StudioApplicationHistoryFailure | undefined;
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active") return declined(resolved.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable", reason: "session_unavailable" }
      : { kind: "refused", reason: "session_ended" });
    const result = await humanOrganizationRequests().run(resolved.session,
      { organizationId: organization.data }, async (transaction, scope, issuedAt): Promise<Value> => {
        try {
          if (!sameId(scope.organizationId, organization.data)) throw new HistoryRefused();
          const context = await readLiveHumanContext(transaction, { scope, session: resolved.session, issuedAt });
          const authority = createBuilderAuthority({ transaction, scope, targetFacts, permissions: platformPermissionSource });
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId: root.data });
          const draft = await readApplicationDefinitionDraft(transaction, scope, { rootId: root.data });
          const anchor = draft.publishedRevision ?? null;
          if (expected !== undefined && (draft.draftRevision !== expected.draftRevision ||
            draft.sourceFingerprint !== expected.sourceFingerprint || anchor !== expected.anchorReleaseRevision))
            throw new HistoryConflict();
          const snapshot = snapshotSchema.parse({
            organizationId: scope.organizationId, rootId: draft.rootId, definitionKey: draft.key,
            draftRevision: draft.draftRevision, sourceFingerprint: draft.sourceFingerprint,
            anchorReleaseRevision: anchor, correlationId: context.correlationId,
          });
          const output = await read(transaction, draft, snapshot);
          const final = await readApplicationDefinitionDraft(transaction, scope,
            { rootId: root.data, expectedDraftRevision: draft.draftRevision });
          if (canonicalJson(final) !== canonicalJson(draft)) throw new HistoryConflict();
          await targetFacts(transaction, scope, root.data);
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId: root.data });
          const completion = await readLiveHumanContext(transaction, { scope, session: resolved.session, issuedAt });
          if (canonicalJson(completion) !== canonicalJson(context)) throw new HistoryRefused();
          await assertLiveCompletion(transaction, completion, output.metadata);
          return output.value;
        } catch (error) {
          failure = safeFailure(error);
          // Even expected refusals and conflicts leave through the original transaction.
          throw error;
        }
      });
    if (result.kind === "available") return { kind: "available", value: result.value };
    return failure ?? declined(result.kind === "unavailable"
      ? { kind: "refused", reason: "organization_unavailable" }
      : { kind: "temporarily_unavailable", reason: "request_failed" });
  } catch (error) { return failure ?? safeFailure(error); }
};

const readPage = async (
  transaction: RequestDatabaseTransaction, rootId: string, anchor: number,
  after: number | null, size: number,
): Promise<Readonly<{ entries: readonly DefinitionReleaseMetadata[]; nextAfterReleaseRevision: number | null }>> => {
  const rows = await transaction.query<DatabaseRow>`
    select vortex_definition.read_publication_history_page(
      ${rootId}::uuid, ${anchor}::bigint, ${after}::bigint, ${size}::integer
    ) as publication_history_page
  `;
  const parsed = pageSchema.safeParse(rows[0]?.publication_history_page);
  if (rows.length !== 1 || !parsed.success || parsed.data.anchorReleaseRevision !== anchor ||
    parsed.data.entries.length > size) throw new HistoryStorageUnavailable();
  const page = parsed.data;
  let previous = after;
  const entries = page.entries.map((entry, index) => {
    const publication = entry.release.publication;
    if (after !== null && index === 0 && entry.previousReleaseRevision !== after) throw new HistoryRefused();
    if (!sameId(publication.rootId, rootId) || publication.kind !== "application" ||
      publication.revision <= (previous ?? 0) || publication.revision > anchor ||
      entry.previousReleaseRevision !== previous)
      throw new HistoryStorageUnavailable();
    const metadata = definitionReleaseMetadataSchema.safeParse({
      releaseRevision: publication.revision, releaseVersion: publication.releaseVersion,
      sourceFingerprint: entry.release.evidence.authoredSourceFingerprint,
      releaseNote: entry.release.releaseNote,
      publishedAt: publication.publishedAt, publishedBy: publication.publishedBy,
      isCurrent: publication.revision === anchor,
    });
    if (!metadata.success) throw new HistoryStorageUnavailable();
    previous = publication.revision;
    return metadata.data;
  });
  if (page.nextAfterReleaseRevision === null ? previous !== anchor :
    page.nextAfterReleaseRevision !== previous || previous === null || previous >= anchor || entries.length !== size)
    throw new HistoryStorageUnavailable();
  return { entries, nextAfterReleaseRevision: page.nextAfterReleaseRevision };
};

export const listStudioApplicationReleaseHistory = async (
  organizationId: string, candidate: unknown,
): Promise<StudioApplicationHistoryListResult> => {
  const request = listRequestSchema.safeParse(candidate);
  if (!request.success) return declined({ kind: "refused", reason: "request_invalid" });
  const command = request.data;
  if (command.kind === "next" && (command.expected.anchorReleaseRevision === null ||
    command.afterReleaseRevision >= command.expected.anchorReleaseRevision))
    return declined({ kind: "refused", reason: "request_invalid" });
  const result = await executeRead(organizationId, command.rootId,
    command.kind === "next" ? command.expected : undefined, async (transaction, _draft, snapshot) => {
      const page = snapshot.anchorReleaseRevision === null
        ? { entries: [], nextAfterReleaseRevision: null }
        : await readPage(transaction, snapshot.rootId, snapshot.anchorReleaseRevision,
          command.kind === "next" ? command.afterReleaseRevision : null, pageSize);
      // Who published each version, read in the same request with the viewer's own directory access.
      const authors = [...new Set(page.entries.map((entry) => entry.publishedBy.toLowerCase()))];
      const names = authors.length === 0 ? new Map<string, string>() : await readVisiblePersonLabels(transaction, authors);
      return { value: { snapshot, ...page, publishers: Object.fromEntries(names) }, metadata: page.entries };
    });
  return result.kind === "available" ? { kind: "available", page: result.value } : result;
};
