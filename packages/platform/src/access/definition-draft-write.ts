import "server-only";

import { z } from "zod";
import {
  applicationRootIdSchema,
  fingerprintSchema,
  pageIdSchema,
  organizationIdSchema,
  platformIdSchema,
  revisionSchema,
} from "../catalogue/identifiers";
import { describeFailure, sameId } from "../catalogue/runtime-primitives";
import { canonicalJson } from "../definition/canonical-json";
import {
  applicationSourceDocumentSchema,
  type ApplicationSourceDocument,
} from "../definition/definition-source";
import {
  createDefinitionRootCommandSchema,
  saveDefinitionDraftCommandSchema,
  type StoredDefinitionDraft,
} from "../definition/definition-store-contracts";
import type { IdentitySession, SelectedOrganizationScope } from "./identity-access";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";
import type { PlatformPermissionSource } from "./platform-permissions";
import {
  assertBeforeLiveDeadline,
  assertLivePermission,
  LiveContextRefused,
  platformOrganizationPermissionDeclaration,
  readDatabaseClock,
  readLiveHumanContext,
} from "./live-context";
import { BuilderAuthorityError, requireBuilderAuthority } from "../definition/builder-authority";
import {
  readApplicationDefinitionDraft,
  type StoredApplicationDefinitionDraft,
} from "../definition/definition-draft-read";
import { createDefinitionStore } from "../definition/definition-store";
import { extractApplicationSourceIdentityRequirements } from "../definition/source-identities";
import {
  createBuilderAuthority,
  type BuilderTargetFactsReader,
  readBuilderApplicationOrigin,
} from "./builder-authority";
import type { createHumanOrganizationRequestService } from "./human-organization-request";
import { DefinitionError, classifyDatabaseError } from "../definition/definition-error";

/** Why a draft write was refused, in terms the person can act on. */
export type HumanApplicationDraftRefusalReason =
  | "permission_missing"
  | "source_invalid"
  | "context_changed"
  | "session_ended"
  | "identity_retired";

/** Why a draft write conflicted, in terms the person can act on. */
export type HumanApplicationDraftConflictReason =
  "draft_changed" | "key_exists" | "alias_conflict" | "draft_missing";

export type HumanApplicationDraftWriteResult =
  | Readonly<{ kind: "available"; draft: StoredApplicationDefinitionDraft }>
  | Readonly<{ kind: "conflict"; reason?: HumanApplicationDraftConflictReason }>
  | Readonly<{ kind: "refused"; reason?: HumanApplicationDraftRefusalReason; sentence?: string }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

export type HumanApplicationDraftWriterDependencies = Readonly<{
  requests: ReturnType<typeof createHumanOrganizationRequestService>;
  /** The shipped platform permission catalogue the draft write is judged against. */
  permissions: PlatformPermissionSource;
}>;

function invalidResult(): never {
  throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
}

/** Unknown, missing, foreign and wrong-kind roots share one neutral conflict. */
const targetFacts: BuilderTargetFactsReader = async (transaction, _scope, rootId) => {
  if (rootId === undefined) return { isSystemApplication: false };
  const origin = await readBuilderApplicationOrigin(transaction, rootId);
  if (origin === undefined) throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING");
  return { isSystemApplication: origin === "platform_system_application" };
};

const derivedDraftCommandSchema = z
  .object({
    rootId: applicationRootIdSchema,
    expectedDraftRevision: revisionSchema,
    expectedPublicationAnchor: revisionSchema,
    candidateReleaseRevision: revisionSchema,
    originalPageId: pageIdSchema,
    replacementPageId: pageIdSchema,
    comparisonFingerprint: fingerprintSchema,
    decision: z.enum(["keep_replacement", "adopt_original"]),
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("navigation"), id: platformIdSchema }).strict(),
      z.object({ kind: z.literal("role_home"), id: platformIdSchema }).strict(),
      z.object({ kind: z.literal("application_home"), id: applicationRootIdSchema }).strict(),
    ]),
  })
  .strict();

type DerivedDraftCommand = z.infer<typeof derivedDraftCommandSchema>;
type DerivedDraftMaterialization = Readonly<{
  source: ApplicationSourceDocument;
  verifySaved: (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    draft: StoredApplicationDefinitionDraft,
  ) => Promise<void>;
}>;
type DerivedDraftWriteResult =
  | Readonly<{ kind: "saved"; draft: StoredApplicationDefinitionDraft }>
  | Readonly<{ kind: "no_change"; draftRevision: number; sourceFingerprint: string }>;

/** Re-evaluate after result validation; a saved row alone is never permission evidence. */
const assertLiveCompletion = async (
  permissions: PlatformPermissionSource,
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  draft: StoredApplicationDefinitionDraft,
): Promise<void> => {
  const facts = await targetFacts(transaction, scope, draft.rootId);
  const context = await readLiveHumanContext(transaction, { scope, session, issuedAt });
  let deadline = Date.parse(context.expiresAt);
  for (const key of [
    "platform.organization.definition_drafts.manage",
    ...(facts.isSystemApplication ? ["platform.organization.system_applications.manage"] : []),
  ]) {
    const decision = await assertLivePermission(
      transaction,
      platformOrganizationPermissionDeclaration(permissions, key),
      context,
    );
    if (Date.parse(draft.updatedAt) > decision.completedAt)
      throw new LiveContextRefused("request_deadline_passed");
    deadline = Math.min(deadline, decision.validUntil);
  }
  // A first permission must still be live after a second permission's evaluation completes.
  await assertBeforeLiveDeadline(transaction, deadline);
};

const verifySavedDraft = (
  draft: StoredDefinitionDraft,
  scope: SelectedOrganizationScope,
  writeStartedAt: number,
  command?: Readonly<{ rootId: string; expectedDraftRevision: number }>,
): StoredApplicationDefinitionDraft => {
  // The store parsed and bound the returned source once at the database boundary.
  if (draft.kind !== "application") invalidResult();
  if (
    draft.source.kind !== "application" ||
    !sameId(draft.organizationId, scope.organizationId) ||
    !sameId(draft.updatedBy, scope.organizationAccountId) ||
    draft.draftRevision !== (command === undefined ? 1 : command.expectedDraftRevision + 1) ||
    Date.parse(draft.updatedAt) < writeStartedAt ||
    Date.parse(draft.updatedAt) < Date.parse(draft.createdAt) ||
    draft.restoredFromReleaseRevision !== undefined ||
    draft.restoredFromSourceFingerprint !== undefined ||
    draft.restoredAt !== undefined ||
    draft.restoredBy !== undefined ||
    draft.restoreCorrelationId !== undefined
  )
    invalidResult();
  if (command === undefined) {
    if (
      !sameId(draft.createdBy, scope.organizationAccountId) ||
      draft.createdAt !== draft.updatedAt ||
      draft.publishedRevision !== undefined
    )
      invalidResult();
  } else if (!sameId(draft.rootId, command.rootId)) invalidResult();
  return draft;
};

const safeFailure = (error: unknown): HumanApplicationDraftWriteResult => {
  if (error instanceof BuilderAuthorityError)
    return { kind: "refused", reason: "permission_missing" };
  if (error instanceof DefinitionError) {
    if (error.code === "DEFINITION_IDENTITY_RETIRED")
      return {
        kind: "refused",
        reason: "identity_retired",
        ...(error.sentence === undefined ? {} : { sentence: error.sentence }),
      };
    if (error.code === "DEFINITION_DRAFT_STALE_OR_MISSING")
      return { kind: "conflict", reason: "draft_changed" };
    if (error.code === "DEFINITION_ROOT_MISSING")
      return { kind: "conflict", reason: "draft_missing" };
    if (error.code === "DEFINITION_ROOT_ALREADY_EXISTS")
      return { kind: "conflict", reason: "key_exists" };
    if (error.code === "DEFINITION_IDENTITY_ALIAS_CONFLICT")
      return { kind: "conflict", reason: "alias_conflict" };
    if (error.code === "INVALID_DEFINITION_COMMAND" || error.code === "INVALID_DEFINITION_SOURCE")
      return { kind: "refused", reason: "source_invalid" };
    if (
      error.code === "DEFINITION_CONTEXT_REFUSED" ||
      error.code === "DEFINITION_STORAGE_VALIDATION_FAILED"
    )
      return { kind: "refused", reason: "context_changed" };
  }
  return { kind: "temporarily_unavailable" };
};

/**
 * One log line per refusal: a stable code naming the write and the reason, plus the cause class.
 * A failure thrown through the request transaction is logged with its cause (and its stable
 * definition code) by the request boundary, so it is not logged again here.
 */
const logDraftWriteFailure = (
  mode: "create" | "save",
  result: HumanApplicationDraftWriteResult,
  cause: unknown,
): void => {
  const reason =
    result.kind === "refused" || result.kind === "conflict"
      ? (result.reason ?? "unspecified")
      : "unavailable";
  console.error(
    `[studio] application draft ${mode} ${result.kind} ${
      mode === "create" ? "STUDIO_DRAFT_CREATE" : "STUDIO_DRAFT_SAVE"
    }_${reason.toUpperCase()}: ${cause === undefined ? "none" : describeFailure(cause)}`,
  );
};

/** SAME store operations and one resolved human change transaction, with no System identity. */
export const createHumanApplicationDraftWriter = (
  dependencies: HumanApplicationDraftWriterDependencies,
) => {
  const write = async (
    session: IdentitySession,
    organizationId: string,
    candidate: unknown,
    mode: "create" | "save",
  ): Promise<HumanApplicationDraftWriteResult> => {
    const organization = organizationIdSchema.safeParse(organizationId);
    const createCommand =
      mode === "create"
        ? createDefinitionRootCommandSchema.extend({ source: z.unknown() }).safeParse(candidate)
        : undefined;
    const saveCommandResult =
      mode === "save"
        ? saveDefinitionDraftCommandSchema.extend({ source: z.unknown() }).safeParse(candidate)
        : undefined;
    const command = createCommand ?? saveCommandResult;
    if (!organization.success || command === undefined || !command.success) {
      const refused: HumanApplicationDraftWriteResult = {
        kind: "refused",
        reason: "source_invalid",
      };
      logDraftWriteFailure(
        mode,
        refused,
        command?.success === false ? command.error : organization.error,
      );
      return refused;
    }
    const saveCommand = saveCommandResult?.success ? saveCommandResult.data : undefined;
    let failure: HumanApplicationDraftWriteResult | undefined;
    const result = await dependencies.requests.runChange(
      session,
      { organizationId: organization.data },
      async (transaction, scope, issuedAt): Promise<StoredApplicationDefinitionDraft> => {
        try {
          if (
            !sameId(scope.organizationId, organization.data) ||
            scope.applicationRootId !== undefined
          )
            throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
          const authority = createBuilderAuthority({
            transaction,
            scope,
            targetFacts,
            permissions: dependencies.permissions,
          });
          const store = createDefinitionStore(transaction, authority, dependencies.permissions);
          let saved: StoredDefinitionDraft;
          let writeStartedAt: number;
          if (mode === "create") {
            writeStartedAt = await readDatabaseClock(transaction);
            saved = await store.createRoot(command.data);
          } else {
            if (saveCommand === undefined) throw new DefinitionError("INVALID_DEFINITION_COMMAND");
            // save_draft binds the root kind/key and expected revision in its conditional UPDATE.
            // Root creation/publication metadata is returned by SQL and is not changed by a save.
            writeStartedAt = await readDatabaseClock(transaction);
            saved = await store.saveDraft(saveCommand);
          }
          const draft = verifySavedDraft(saved, scope, writeStartedAt, saveCommand);
          await assertLiveCompletion(
            dependencies.permissions,
            transaction,
            scope,
            session,
            issuedAt,
            draft,
          );
          return draft;
        } catch (error) {
          failure = safeFailure(error);
          // Throw through runChange so every partial write is rolled back before safe mapping.
          throw error;
        }
      },
    );
    if (result.kind === "available") return { kind: "available", draft: result.value };
    if (failure !== undefined) return failure;
    const unresolved: HumanApplicationDraftWriteResult =
      result.kind === "unavailable"
        ? { kind: "refused", reason: "context_changed" }
        : { kind: "temporarily_unavailable" };
    logDraftWriteFailure(mode, unresolved, undefined);
    return unresolved;
  };
  const writeDerived = async (
    session: IdentitySession,
    organizationId: string,
    candidate: unknown,
    derive: (
      input: Readonly<{
        transaction: RequestDatabaseTransaction;
        scope: SelectedOrganizationScope;
        session: IdentitySession;
        issuedAt: string;
        draft: StoredApplicationDefinitionDraft;
        command: DerivedDraftCommand;
      }>,
    ) => Promise<DerivedDraftMaterialization>,
  ): Promise<
    | HumanApplicationDraftWriteResult
    | Readonly<{
        kind: "no_change";
        draftRevision: number;
        sourceFingerprint: string;
      }>
  > => {
    const organization = organizationIdSchema.safeParse(organizationId);
    const command = derivedDraftCommandSchema.safeParse(candidate);
    if (!organization.success || !command.success) {
      const refused: HumanApplicationDraftWriteResult = {
        kind: "refused",
        reason: "source_invalid",
      };
      logDraftWriteFailure("save", refused, command.success ? organization.error : command.error);
      return refused;
    }
    if (command.data.candidateReleaseRevision !== command.data.expectedPublicationAnchor)
      return { kind: "conflict" };

    let failure: HumanApplicationDraftWriteResult | undefined;
    const result = await dependencies.requests.runChange(
      session,
      { organizationId: organization.data },
      async (transaction, scope, issuedAt): Promise<DerivedDraftWriteResult> => {
        try {
          if (
            !sameId(scope.organizationId, organization.data) ||
            scope.applicationRootId !== undefined
          )
            throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
          const authority = createBuilderAuthority({
            transaction,
            scope,
            targetFacts,
            permissions: dependencies.permissions,
          });
          await requireBuilderAuthority(authority, {
            kind: "draft_change",
            rootId: command.data.rootId,
          });
          const target = await targetFacts(transaction, scope, command.data.rootId);
          if (target.isSystemApplication) throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
          let locked: readonly DatabaseRow[];
          try {
            locked = await transaction.query<DatabaseRow>`
              select vortex_definition.lock_application_page_adoption_draft_internal(
                ${command.data.rootId}::uuid,
                ${command.data.expectedDraftRevision},
                ${command.data.expectedPublicationAnchor}
              ) as publication_state
            `;
          } catch (error) {
            const kind = classifyDatabaseError(error);
            if (kind === "conflict") throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING");
            if (kind === "refused") throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
            if (kind === "invalid") throw new DefinitionError("INVALID_DEFINITION_COMMAND");
            throw error;
          }
          if (
            locked.length !== 1 ||
            locked[0]?.publication_state === null ||
            locked[0]?.publication_state === undefined
          )
            invalidResult();

          const previous = await readApplicationDefinitionDraft(transaction, scope, {
            rootId: command.data.rootId,
            expectedDraftRevision: command.data.expectedDraftRevision,
          });
          if (
            previous.kind !== "application" ||
            previous.publishedRevision !== command.data.expectedPublicationAnchor
          )
            throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING");
          const materialized = await derive({
            transaction,
            scope,
            session,
            issuedAt,
            draft: previous,
            command: command.data,
          });
          const source = materialized.source;
          if (source.key !== previous.key || !sameId(source.root_alias, previous.source.root_alias))
            throw new DefinitionError("INVALID_DEFINITION_COMMAND");

          if (canonicalJson(source) === canonicalJson(previous.source)) {
            await materialized.verifySaved(transaction, scope, previous);
            await assertLiveCompletion(
              dependencies.permissions,
              transaction,
              scope,
              session,
              issuedAt,
              previous,
            );
            return {
              kind: "no_change",
              draftRevision: previous.draftRevision,
              sourceFingerprint: previous.sourceFingerprint,
            };
          }

          const writeStartedAt = await readDatabaseClock(transaction);
          const store = createDefinitionStore(transaction, authority, dependencies.permissions);
          const saved = await store.saveDraft({
            rootId: platformIdSchema.parse(command.data.rootId),
            expectedDraftRevision: command.data.expectedDraftRevision,
            source,
          });
          const verified = verifySavedDraft(saved, scope, writeStartedAt, command.data);
          if (verified.publishedRevision !== previous.publishedRevision) invalidResult();
          await materialized.verifySaved(transaction, scope, verified);
          await assertLiveCompletion(
            dependencies.permissions,
            transaction,
            scope,
            session,
            issuedAt,
            verified,
          );
          return { kind: "saved", draft: verified };
        } catch (error) {
          failure = safeFailure(error);
          // Throw through runChange so every partial write is rolled back before safe mapping.
          throw error;
        }
      },
    );
    if (result.kind === "available") {
      if (result.value.kind === "no_change") return result.value;
      return { kind: "available", draft: result.value.draft };
    }
    if (failure !== undefined) return failure;
    const unresolved: HumanApplicationDraftWriteResult =
      result.kind === "unavailable"
        ? { kind: "refused", reason: "context_changed" }
        : { kind: "temporarily_unavailable" };
    logDraftWriteFailure("save", unresolved, undefined);
    return unresolved;
  };
  return Object.freeze({
    reviewSource: async (session: IdentitySession, organizationId: string, candidate: unknown) => {
      const organization = organizationIdSchema.parse(organizationId);
      const command = saveDefinitionDraftCommandSchema.parse(candidate);
      const source = applicationSourceDocumentSchema.parse(command.source);
      const result = await dependencies.requests.run(
        session,
        { organizationId: organization },
        async (transaction, scope) => {
          const authority = createBuilderAuthority({
            transaction,
            scope,
            targetFacts,
            permissions: dependencies.permissions,
          });
          await requireBuilderAuthority(authority, {
            kind: "draft_change",
            rootId: command.rootId,
          });
          const draft = await readApplicationDefinitionDraft(transaction, scope, {
            rootId: applicationRootIdSchema.parse(command.rootId),
            expectedDraftRevision: command.expectedDraftRevision,
          });
          if (draft.key !== source.key || draft.source.root_alias !== source.root_alias)
            throw new DefinitionError("INVALID_DEFINITION_COMMAND");
          const requirements = extractApplicationSourceIdentityRequirements(source);
          const rows = await transaction.query<
            DatabaseRow & { component_kind: unknown; component_name: unknown }
          >`
          select component_kind, component_name from vortex_definition.read_source_import_conflicts(
            ${command.rootId}::uuid, ${JSON.stringify(requirements)}::text::jsonb
          )
        `;
          const conflicts = z
            .array(z.object({ component_kind: z.string(), component_name: z.string() }).strict())
            .parse(rows);
          await requireBuilderAuthority(authority, {
            kind: "draft_change",
            rootId: command.rootId,
          });
          return conflicts.map((row) => ({ kind: row.component_kind, name: row.component_name }));
        },
      );
      return result.kind === "available"
        ? ({ kind: "available", conflicts: result.value } as const)
        : ({ kind: "temporarily_unavailable" } as const);
    },
    createRoot: (session: IdentitySession, organizationId: string, candidate: unknown) =>
      write(session, organizationId, candidate, "create"),
    saveDraft: (session: IdentitySession, organizationId: string, candidate: unknown) =>
      write(session, organizationId, candidate, "save"),
    saveDerivedDraft: (
      session: IdentitySession,
      organizationId: string,
      candidate: unknown,
      derive: (
        input: Readonly<{
          transaction: RequestDatabaseTransaction;
          scope: SelectedOrganizationScope;
          session: IdentitySession;
          issuedAt: string;
          draft: StoredApplicationDefinitionDraft;
          command: DerivedDraftCommand;
        }>,
      ) => Promise<DerivedDraftMaterialization>,
    ) => writeDerived(session, organizationId, candidate, derive),
  });
};
