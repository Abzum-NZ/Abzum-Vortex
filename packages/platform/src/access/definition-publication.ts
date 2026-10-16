import "server-only";

import {
  applicationRootIdSchema, canonicalJson, databaseTimestamp,
  moduleRootIdSchema,
  organizationIdSchema, prepareDefinitionPublicationCommandSchema,
  prepareDefinitionPublicationResultSchema, publishDefinitionCommandSchema,
  publishDefinitionResultSchema, sameId, timestampSchema,
  type IdentitySession, type PrepareDefinitionPublicationResult, type PublishDefinitionResult,
  type SelectedOrganizationScope,
} from "../schema";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import {
  BuilderAuthorityError, createDatabaseDefinitionPublicationService,
  readApplicationDefinitionDraft, readModuleDefinitionDraft, requireBuilderAuthority,
  type ImmutableDefinitionPublicationCatalogueDefinition,
  type StoredApplicationDefinitionDraft, type StoredModuleDefinitionDraft,
} from "../definition/definition-index";
import {
  assertBeforeLiveDeadline, assertLivePermission, LiveContextRefused,
  platformOrganizationPermissionDeclaration, readLiveHumanContext, type LiveHumanContext,
} from "./live-context";
import { createBuilderAuthority, type BuilderTargetFactsReader } from "./builder-authority";
import type { PlatformPermissionSource } from "./platform-permissions";
import type { createHumanOrganizationRequestService } from "./human-organization-request";
import { DefinitionCompilationError, DefinitionError, isVersionImpactRefusal } from "../definition/definition-index";

/** `reason` is the stable code logged on the server and mapped to a message for the person. */
type Failure = Readonly<{
  kind: "refused" | "conflict" | "dependency_unavailable" | "no_change" | "temporarily_unavailable";
  reason?: string;
}>;
export type HumanDefinitionPublicationPreparationResult = Failure |
  Readonly<{ kind: "available"; preparation: PrepareDefinitionPublicationResult }>;
export type HumanDefinitionPublicationResult = Failure |
  Readonly<{ kind: "available"; publication: PublishDefinitionResult }>;
export type HumanDefinitionPublicationDraft = StoredApplicationDefinitionDraft | StoredModuleDefinitionDraft;
export type HumanDefinitionPublicationDraftResult = Failure |
  Readonly<{ kind: "available"; draft: HumanDefinitionPublicationDraft }>;
export type HumanDefinitionPublisherDependencies = Readonly<{
  requests: ReturnType<typeof createHumanOrganizationRequestService>;
  catalogue: ImmutableDefinitionPublicationCatalogueDefinition;
}>;
export type HumanDefinitionKind = "application" | "module";
class PublicationContextRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "PublicationContextRefused";
  }
}
/** Trusted refusal code consumed by the owning request after its transaction rolls back. */
class ExpectedBuilderPublicationRefusal extends Error {
  readonly code = "42501";
  constructor() {
    super("Definition publication authority refused");
    this.name = "ExpectedBuilderPublicationRefusal";
  }
}

/** Existing roots never acquire a default classification or a System fallback. */
const targetFacts: BuilderTargetFactsReader = async (transaction, _scope, rootId) => {
  if (rootId === undefined) throw new PublicationContextRefused("root_missing");
  const rows = await transaction.query<DatabaseRow>`
    select outcome, application_origin_kind
    from vortex_definition.read_builder_application_root_classification(${rootId}::uuid)
  `;
  if (rows.length !== 1 || rows[0]?.outcome !== "available" ||
    rows[0]?.application_origin_kind !== "ordinary") throw new PublicationContextRefused("application_root_not_ordinary");
  return { isSystemApplication: false };
};

/** A Module root is proved from its own protected draft in the selected organization. */
const moduleTargetFacts: BuilderTargetFactsReader = async (transaction, scope, candidateRootId) => {
  const root = moduleRootIdSchema.safeParse(candidateRootId);
  if (!root.success) throw new PublicationContextRefused("module_root_invalid");
  const draft = await readModuleDefinitionDraft(transaction, scope, { rootId: root.data });
  if (draft.kind !== "module" || !sameId(draft.rootId, root.data) ||
    !sameId(draft.organizationId, scope.organizationId)) throw new PublicationContextRefused("module_root_mismatch");
  return { isSystemApplication: false };
};

/** Recheck exact decisions after compilation/append and all returned-row verification. */
const assertLiveCompletion = async (
  permissions: PlatformPermissionSource,
  transaction: RequestDatabaseTransaction, context: LiveHumanContext, publishedAt?: string,
): Promise<void> => {
  let deadline = Date.parse(context.expiresAt);
  for (const key of ["platform.organization.definition_releases.manage"]) {
    const decision = await assertLivePermission(
      transaction, platformOrganizationPermissionDeclaration(permissions, key), context,
    );
    deadline = Math.min(deadline, decision.validUntil);
  }
  const now = await assertBeforeLiveDeadline(transaction, deadline);
  if (publishedAt !== undefined && Date.parse(publishedAt) > now)
    throw new LiveContextRefused("request_deadline_passed");
};

const dependencyCodes = [
  "DEFINITION_DEPENDENCY_MISSING", "DEFINITION_DEPENDENCY_PRERELEASE_ONLY",
  "DEFINITION_DEPENDENCY_INCOMPATIBLE", "DEFINITION_DEPENDENCY_AMBIGUOUS",
  "DEFINITION_DEPENDENCY_SUBSTITUTED", "DEFINITION_DEPENDENCY_CYCLE",
];

const classifyFailure = (error: unknown): Failure => {
  if (error instanceof DefinitionError && error.code === "DEFINITION_NO_CHANGE")
    return { kind: "no_change", reason: "no_change" };
  if (error instanceof DefinitionError && dependencyCodes.includes(error.code))
    return { kind: "dependency_unavailable", reason: error.code.slice("DEFINITION_".length).toLowerCase() };
  if (error instanceof DefinitionError && error.code === "DEFINITION_DRAFT_STALE_OR_MISSING")
    return { kind: "conflict", reason: "draft_stale_or_missing" };
  if (error instanceof DefinitionError && error.code === "DEFINITION_CONFIRMATION_MISMATCH")
    return { kind: "conflict", reason: "confirmation_mismatch" };
  if (error instanceof PublicationContextRefused || error instanceof LiveContextRefused)
    return { kind: "refused", reason: error.reason };
  if (error instanceof BuilderAuthorityError) return {
    kind: "refused",
    reason: error.code === "BUILDER_PERMISSION_REFUSED" ? "release_permission_missing"
      : "recent_authentication_required",
  };
  if (error instanceof DefinitionCompilationError)
    return { kind: "refused", reason: `compilation_${error.ruleCode.toLowerCase()}` };
  if (isVersionImpactRefusal(error)) return { kind: "refused", reason: "version_impact_refused" };
  if (error instanceof DefinitionError && error.code !== "DEFINITION_PUBLICATION_FAILED")
    return { kind: "refused", reason: error.code.replace(/^DEFINITION_/, "").toLowerCase() };
  return { kind: "temporarily_unavailable", reason: "unexpected_failure" };
};

const causeSummary = (error: unknown): string => {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as { readonly code?: unknown }).code;
    const message = current.name === "DefinitionError" || current.name === "PublicationContextRefused" ||
      current.name === "LiveContextRefused"
      ? "" : `:${current.message.slice(0, 160)}`;
    parts.push(`${current.name}/${typeof code === "string" ? code.slice(0, 64) : "none"}${message}`);
    current = current.cause;
  }
  return parts.join(" <- ") || typeof error;
};

/** Classifies a failure and logs one line with its stable reason code and cause chain. */
const safeFailure = (error: unknown, operation: string): Failure => {
  const failure = classifyFailure(error);
  console.error(
    `[publication] ${operation} ${failure.kind} reason=${failure.reason ?? "none"} cause=${causeSummary(error)}`,
  );
  return failure;
};

/** Both operations resolve their own human scope; no caller-supplied source, actor or history. */
export const createHumanDefinitionPublisher = (dependencies: HumanDefinitionPublisherDependencies) => {
  type Value = Readonly<{ kind: "prepared"; preparation: PrepareDefinitionPublicationResult }> |
    Readonly<{ kind: "published"; publication: PublishDefinitionResult }>;
  const execute = async (
    session: IdentitySession, candidateOrganizationId: string, candidate: unknown,
    mode: "prepare" | "publish",
  ): Promise<Failure | Readonly<{ kind: "available"; value: Value }>> => {
    const organization = organizationIdSchema.safeParse(candidateOrganizationId);
    const prepare = mode === "prepare" ? prepareDefinitionPublicationCommandSchema.safeParse(candidate) : undefined;
    const publish = mode === "publish" ? publishDefinitionCommandSchema.safeParse(candidate) : undefined;
    const supplied = prepare?.success ? prepare.data : publish?.success ? {
      rootId: publish.data.confirmation.rootId,
      expectedDraftRevision: publish.data.confirmation.expectedDraftRevision,
    } : undefined;
    // Only an Application is published; its inline Modules are released inside its publication.
    const root = applicationRootIdSchema.safeParse(supplied?.rootId);
    if (!organization.success || supplied === undefined || !root.success) {
      console.error(`[publication] ${mode} refused reason=command_invalid cause=schema/none`);
      return { kind: "refused", reason: "command_invalid" };
    }
    const command = { rootId: root.data, expectedDraftRevision: supplied.expectedDraftRevision };
    let failure: Failure | undefined;
    const operation = async (transaction: RequestDatabaseTransaction,
      scope: SelectedOrganizationScope, issuedAt: string): Promise<Value> => {
      try {
        if (!sameId(scope.organizationId, organization.data)) throw new PublicationContextRefused("organization_mismatch");
        const context = await readLiveHumanContext(transaction, { scope, session, issuedAt });
        const authority = createBuilderAuthority({ transaction, scope, targetFacts,
          permissions: dependencies.catalogue.permissions });
        await requireBuilderAuthority(authority, { kind: "publication", rootId: command.rootId });
        const readDraftAtRevision = () => readApplicationDefinitionDraft(transaction, scope, {
          rootId: root.data, expectedDraftRevision: command.expectedDraftRevision,
        });
        const initial = await readDraftAtRevision();
        if (initial.kind !== "application") throw new PublicationContextRefused("draft_kind_mismatch");
        // A draft not saved since the last release has nothing to publish.
        if (initial.publishedRevision !== undefined && initial.publishedRevision !== null &&
          initial.draftRevision <= initial.publishedRevision)
          throw new DefinitionError("DEFINITION_NO_CHANGE");
        const clocks = await transaction.query<DatabaseRow>`select pg_catalog.clock_timestamp() as started_at`;
        const started = timestampSchema.safeParse(databaseTimestamp(clocks[0]?.started_at));
        if (clocks.length !== 1 || !started.success) throw new PublicationContextRefused("database_clock_invalid");
        const service = createDatabaseDefinitionPublicationService(dependencies.catalogue, transaction, authority);
        let value: Value;
        if (mode === "prepare") {
          const preparation = prepareDefinitionPublicationResultSchema.parse(await service.prepare(context, command));
          if (!sameId(preparation.confirmation.rootId, initial.rootId) ||
            preparation.confirmation.expectedDraftRevision !== initial.draftRevision ||
            preparation.confirmation.sourceFingerprint !== initial.sourceFingerprint)
            throw new DefinitionError("DEFINITION_SOURCE_EVIDENCE_MISMATCH");
          value = { kind: "prepared", preparation };
        } else {
          if (!publish?.success) throw new PublicationContextRefused("publish_command_invalid");
          const publication = publishDefinitionResultSchema.parse(await service.publish(context, publish.data));
          const expected = publish.data.confirmation;
          if (!sameId(publication.rootId, initial.rootId) ||
            publication.releaseRevision !== initial.draftRevision ||
            publication.releaseVersion !== expected.assignedVersion ||
            publication.contentFingerprint !== expected.contentFingerprint ||
            publication.resolutionFingerprint !== expected.resolutionFingerprint ||
            canonicalJson(publication.dependencyManifest) !== canonicalJson(expected.dependencyManifest) ||
            !sameId(publication.publishedBy, scope.organizationAccountId) ||
            Date.parse(publication.publishedAt) < Date.parse(started.data))
            throw new DefinitionError("DEFINITION_PUBLICATION_FAILED");
          value = { kind: "published", publication };
        }
        const final = await readDraftAtRevision();
        if (final.kind !== "application" || !sameId(final.rootId, initial.rootId) || !sameId(final.organizationId, initial.organizationId) ||
          final.key !== initial.key || final.draftRevision !== initial.draftRevision ||
          final.sourceFingerprint !== initial.sourceFingerprint ||
          canonicalJson(final.source) !== canonicalJson(initial.source) ||
          final.createdAt !== initial.createdAt || !sameId(final.createdBy, initial.createdBy) ||
          final.updatedAt !== initial.updatedAt || !sameId(final.updatedBy, initial.updatedBy) ||
          final.publishedRevision !== (value.kind === "published" ? value.publication.releaseRevision : initial.publishedRevision))
          throw new DefinitionError("DEFINITION_SOURCE_EVIDENCE_MISMATCH");
        await targetFacts(transaction, scope, command.rootId);
        const completion = await readLiveHumanContext(transaction, { scope, session, issuedAt });
        if (canonicalJson(completion) !== canonicalJson(context)) throw new PublicationContextRefused("session_context_changed");
        await assertLiveCompletion(dependencies.catalogue.permissions, transaction, completion,
          value.kind === "published" ? value.publication.publishedAt : undefined);
        return value;
      } catch (error) {
        failure = safeFailure(error, mode);
        if (error instanceof BuilderAuthorityError &&
          (error.code === "BUILDER_PERMISSION_REFUSED" ||
            error.code === "BUILDER_RECENT_AUTHENTICATION_REQUIRED"))
          throw new ExpectedBuilderPublicationRefusal();
        // Throw through runChange: even a post-append result mismatch must roll back.
        throw error;
      }
    };
    // Preparation writes the inline Modules' internal drafts, so it is a change as well.
    const result = await dependencies.requests.runChange(
      session, { organizationId: organization.data }, operation,
    );
    if (result.kind === "available") return { kind: "available", value: result.value };
    if (failure !== undefined) return failure;
    const reason = result.kind === "unavailable" ? "organization_unavailable" : "request_failed";
    console.error(`[publication] ${mode} request ${result.kind} reason=${reason}`);
    return result.kind === "unavailable" ? { kind: "refused", reason } : { kind: "temporarily_unavailable", reason };
  };
  const readDraft = async (
    session: IdentitySession, candidateOrganizationId: string, candidateRootId: string,
    definitionKind: HumanDefinitionKind,
  ): Promise<HumanDefinitionPublicationDraftResult> => {
    const organization = organizationIdSchema.safeParse(candidateOrganizationId);
    const root = definitionKind === "application"
      ? applicationRootIdSchema.safeParse(candidateRootId)
      : moduleRootIdSchema.safeParse(candidateRootId);
    if (!organization.success || !root.success) {
      console.error("[publication] read-draft refused reason=command_invalid cause=schema/none");
      return { kind: "refused", reason: "command_invalid" };
    }
    let failure: Failure | undefined;
    const read = async (
      transaction: RequestDatabaseTransaction, scope: SelectedOrganizationScope, issuedAt: string,
    ): Promise<HumanDefinitionPublicationDraft> => {
      try {
        if (!sameId(scope.organizationId, organization.data)) throw new PublicationContextRefused("organization_mismatch");
        const context = await readLiveHumanContext(transaction, { scope, session, issuedAt });
        const facts = definitionKind === "application" ? targetFacts : moduleTargetFacts;
        const authority = createBuilderAuthority({
          transaction, scope, targetFacts: facts, permissions: dependencies.catalogue.permissions,
        });
        await requireBuilderAuthority(authority, { kind: "publication", rootId: root.data });
        const readAtRevision = (expectedDraftRevision?: number) => definitionKind === "application"
          ? readApplicationDefinitionDraft(transaction, scope, {
            rootId: applicationRootIdSchema.parse(root.data),
            ...(expectedDraftRevision === undefined ? {} : { expectedDraftRevision }),
          })
          : readModuleDefinitionDraft(transaction, scope, {
            rootId: moduleRootIdSchema.parse(root.data),
            ...(expectedDraftRevision === undefined ? {} : { expectedDraftRevision }),
          });
        const draft = await readAtRevision();
        if (draft.kind !== definitionKind || !sameId(draft.rootId, root.data) ||
          !sameId(draft.organizationId, organization.data)) throw new PublicationContextRefused("draft_kind_mismatch");
        const exact = await readAtRevision(draft.draftRevision);
        if (canonicalJson(exact) !== canonicalJson(draft))
          throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING");
        await facts(transaction, scope, root.data);
        const completion = await readLiveHumanContext(transaction, { scope, session, issuedAt });
        if (canonicalJson(completion) !== canonicalJson(context)) throw new PublicationContextRefused("session_context_changed");
        await assertLiveCompletion(dependencies.catalogue.permissions, transaction, completion);
        return draft;
      } catch (error) {
        failure = safeFailure(error, "read-draft");
        throw error;
      }
    };
    const result = await dependencies.requests.run(
      session, { organizationId: organization.data }, read,
    );
    return result.kind === "available"
      ? { kind: "available", draft: result.value }
      : failure ?? { kind: result.kind === "unavailable" ? "refused" : "temporarily_unavailable",
        reason: result.kind === "unavailable" ? "organization_unavailable" : "request_failed" };
  };
  return Object.freeze({
    readDraft: async (
      session: IdentitySession, organizationId: string, rootId: string,
      definitionKind: HumanDefinitionKind,
    ): Promise<HumanDefinitionPublicationDraftResult> =>
      readDraft(session, organizationId, rootId, definitionKind),
    prepare: async (session: IdentitySession, organizationId: string, candidate: unknown,
    ): Promise<HumanDefinitionPublicationPreparationResult> => {
      const result = await execute(session, organizationId, candidate, "prepare");
      return result.kind !== "available" ? result : result.value.kind === "prepared"
        ? { kind: "available", preparation: result.value.preparation } : { kind: "temporarily_unavailable" };
    },
    publish: async (session: IdentitySession, organizationId: string, candidate: unknown,
    ): Promise<HumanDefinitionPublicationResult> => {
      const result = await execute(session, organizationId, candidate, "publish");
      return result.kind !== "available" ? result : result.value.kind === "published"
        ? { kind: "available", publication: result.value.publication } : { kind: "temporarily_unavailable" };
    },
  });
};
