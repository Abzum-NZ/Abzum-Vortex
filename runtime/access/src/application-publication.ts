import "server-only";

import { z } from "zod";
import {
  applicationRootIdSchema, canonicalJson, databaseRevision, databaseTimestamp,
  organizationAccessDeclarationSchema, organizationIdSchema,
  organizationPermissionEligibilitySchema, prepareDefinitionPublicationCommandSchema,
  prepareDefinitionPublicationResultSchema, publishDefinitionCommandSchema,
  publishDefinitionResultSchema, sameId, sessionContextSchema, timestampSchema,
  type IdentitySession, type PrepareDefinitionPublicationResult, type PublishDefinitionResult,
  type SelectedOrganizationScope, type SessionContext,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  BuilderAuthorityError, DefinitionPublicationError, DefinitionStoreError,
  createDatabaseDefinitionPublicationService,
  readApplicationDefinitionDraft, requireBuilderAuthority,
  type ImmutableDefinitionPublicationCatalogueDefinition,
} from "@vortex/definition";
import { platformPermissionDeclarations, platformPermissionOwnerId } from "@vortex/modules";
import { createBuilderAuthority, type BuilderTargetFactsReader } from "./builder-authority";
import { createHumanOrganizationRequestService } from "./human-organization-request";

type Failure = Readonly<{ kind: "refused" | "conflict" | "dependency_unavailable" | "no_change" | "temporarily_unavailable" }>;
export type HumanApplicationPublicationPreparationResult = Failure |
  Readonly<{ kind: "available"; preparation: PrepareDefinitionPublicationResult }>;
export type HumanApplicationPublicationResult = Failure |
  Readonly<{ kind: "available"; publication: PublishDefinitionResult }>;
export type HumanApplicationPublisherDependencies = Readonly<{
  requests: ReturnType<typeof createHumanOrganizationRequestService>;
  catalogue: ImmutableDefinitionPublicationCatalogueDefinition;
}>;
type HumanContext = Extract<SessionContext, { callerKind: "human" }>;
class PublicationContextRefused extends Error {}
/** Trusted refusal code consumed by the owning request after its transaction rolls back. */
class ExpectedBuilderPublicationRefusal extends Error {
  readonly code = "42501";
  constructor() {
    super("Application publication authority refused");
    this.name = "ExpectedBuilderPublicationRefusal";
  }
}

/** Existing roots never acquire a default classification or a System fallback. */
const targetFacts: BuilderTargetFactsReader = async (transaction, _scope, rootId) => {
  if (rootId === undefined) throw new PublicationContextRefused();
  const rows = await transaction.query<DatabaseRow>`
    select outcome, application_origin_kind
    from vortex_definition.read_builder_application_root_classification(${rootId}::uuid)
  `;
  if (rows.length !== 1 || rows[0]?.outcome !== "available" ||
    rows[0]?.application_origin_kind !== "ordinary") throw new PublicationContextRefused();
  return { isSystemApplication: false };
};

/** The sole projection removes the trusted web transport channel, never authority fields. */
const readHumanContext = async (
  transaction: RequestDatabaseTransaction, scope: SelectedOrganizationScope,
  session: IdentitySession, issuedAt: string,
): Promise<HumanContext> => {
  const rows = await transaction.query<DatabaseRow>`
    select vortex_access.validated_human_request_context() as request_context,
      pg_catalog.clock_timestamp() as checked_at
  `;
  const row = rows[0];
  const transport = z.record(z.string(), z.unknown()).safeParse(row?.request_context);
  if (rows.length !== 1 || !transport.success || transport.data.channel !== "web")
    throw new PublicationContextRefused();
  const parsed = sessionContextSchema.safeParse(Object.fromEntries(
    Object.entries(transport.data).filter(([key]) => key !== "channel"),
  ));
  const clock = timestampSchema.safeParse(databaseTimestamp(row?.checked_at));
  if (!parsed.success || parsed.data.callerKind !== "human" || !clock.success)
    throw new PublicationContextRefused();
  const context = parsed.data;
  const now = Date.parse(clock.data);
  if (Object.hasOwn(scope, "applicationRootId") || Object.hasOwn(context, "applicationRootId") ||
    context.delegatedContext !== undefined || context.supportContext !== undefined ||
    !sameId(context.tenantId, scope.tenantId) ||
    !sameId(context.organizationId, scope.organizationId) ||
    !sameId(context.organizationAccountId, scope.organizationAccountId) ||
    context.accessVersion !== scope.accessVersion ||
    !sameId(context.identityId, session.identityId) || !sameId(context.sessionId, session.sessionId) ||
    context.authenticationStrength !== session.authenticationStrength ||
    context.issuedAt !== issuedAt || context.expiresAt !== session.accessTokenExpiresAt ||
    context.accessTokenIssuedAt !== (session.primaryAuthenticatedAt !== undefined ||
      session.multiFactorAuthenticatedAt !== undefined ? session.accessTokenIssuedAt : undefined) ||
    context.primaryAuthenticatedAt !== session.primaryAuthenticatedAt ||
    context.multiFactorAuthenticatedAt !== session.multiFactorAuthenticatedAt ||
    Date.parse(context.issuedAt) > now || Date.parse(context.expiresAt) <= now ||
    Date.parse(context.issuedAt) >= Date.parse(context.expiresAt))
    throw new PublicationContextRefused();
  return context;
};

/** Recheck exact decisions after compilation/append and all returned-row verification. */
const assertLiveCompletion = async (
  transaction: RequestDatabaseTransaction, context: HumanContext, publishedAt?: string,
): Promise<void> => {
  let deadline = Date.parse(context.expiresAt);
  for (const key of ["platform.organization.definition_drafts.manage",
    "platform.organization.definition_releases.manage"]) {
    const permission = platformPermissionDeclarations.find((entry) => entry.key === key);
    if (permission === undefined) throw new PublicationContextRefused();
    const declaration = organizationAccessDeclarationSchema.parse({
      operationKey: key, action: { actionKind: permission.actionKind },
      target: { kind: "organization" }, requiredPermission: {
        ownerKind: "platform", ownerId: platformPermissionOwnerId, permissionId: permission.permissionId,
      }, recentAuthentication: { kind: "none" }, authority: { kind: "permission" },
    });
    const rows = await transaction.query<DatabaseRow>`
      select eligibility.*, pg_catalog.clock_timestamp() as completed_at
      from vortex_access.evaluate_organization_permission_eligibility(
        ${JSON.stringify(declaration)}::text::jsonb
      ) as eligibility
    `;
    const row = rows[0];
    const decision = organizationPermissionEligibilitySchema.safeParse({
      outcome: row?.outcome, operationKey: row?.operation_key, target: { kind: row?.target_kind },
      organizationId: row?.organization_id, organizationAccountId: row?.organization_account_id,
      accessVersion: databaseRevision(row?.access_version), checkedAt: databaseTimestamp(row?.checked_at),
      correlationId: row?.correlation_id,
      ...(row?.outcome === "eligible" ? { validUntil: databaseTimestamp(row.valid_until) } :
        { reasonCode: row?.reason_code }),
    });
    const clock = timestampSchema.safeParse(databaseTimestamp(row?.completed_at));
    if (rows.length !== 1 || !decision.success || decision.data.outcome !== "eligible" ||
      !clock.success || decision.data.operationKey !== key || decision.data.target.kind !== "organization" ||
      row?.target_application_root_id !== null || row?.reason_code !== null ||
      !sameId(decision.data.organizationId, context.organizationId) ||
      !sameId(decision.data.organizationAccountId, context.organizationAccountId) ||
      decision.data.accessVersion !== context.accessVersion ||
      !sameId(decision.data.correlationId, context.correlationId) ||
      Date.parse(decision.data.checkedAt) > Date.parse(clock.data) ||
      Date.parse(decision.data.validUntil) <= Date.parse(clock.data))
      throw new PublicationContextRefused();
    deadline = Math.min(deadline, Date.parse(decision.data.validUntil));
  }
  const rows = await transaction.query<DatabaseRow>`select pg_catalog.clock_timestamp() as completed_at`;
  const clock = timestampSchema.safeParse(databaseTimestamp(rows[0]?.completed_at));
  if (rows.length !== 1 || !clock.success || Date.parse(clock.data) >= deadline ||
    (publishedAt !== undefined && Date.parse(publishedAt) > Date.parse(clock.data)))
    throw new PublicationContextRefused();
};

const safeFailure = (error: unknown): Failure => {
  if (error instanceof DefinitionPublicationError && error.code === "DEFINITION_NO_CHANGE")
    return { kind: "no_change" };
  if (error instanceof DefinitionPublicationError && [
    "DEFINITION_DEPENDENCY_MISSING", "DEFINITION_DEPENDENCY_PRERELEASE_ONLY",
    "DEFINITION_DEPENDENCY_INCOMPATIBLE", "DEFINITION_DEPENDENCY_AMBIGUOUS",
    "DEFINITION_DEPENDENCY_SUBSTITUTED", "DEFINITION_DEPENDENCY_CYCLE",
  ].includes(error.code)) return { kind: "dependency_unavailable" };
  if ((error instanceof DefinitionPublicationError || error instanceof DefinitionStoreError) &&
    (error.code === "DEFINITION_DRAFT_STALE_OR_MISSING" ||
      error.code === "DEFINITION_CONFIRMATION_MISMATCH")) return { kind: "conflict" };
  if (error instanceof PublicationContextRefused || error instanceof BuilderAuthorityError)
    return { kind: "refused" };
  if (error instanceof DefinitionPublicationError && error.code !== "DEFINITION_PUBLICATION_FAILED")
    return { kind: "refused" };
  if (error instanceof DefinitionStoreError &&
    (error.code === "DEFINITION_CONTEXT_REFUSED" || error.code === "DEFINITION_ROOT_MISSING" ||
      error.code === "INVALID_DEFINITION_COMMAND")) return { kind: "refused" };
  return { kind: "temporarily_unavailable" };
};

/** Both operations resolve their own human scope; no caller-supplied source, actor or history. */
export const createHumanApplicationPublisher = (dependencies: HumanApplicationPublisherDependencies) => {
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
    const root = applicationRootIdSchema.safeParse(supplied?.rootId);
    if (!organization.success || supplied === undefined || !root.success) return { kind: "refused" };
    const command = { rootId: root.data, expectedDraftRevision: supplied.expectedDraftRevision };
    let failure: Failure | undefined;
    const operation = async (transaction: RequestDatabaseTransaction,
      scope: SelectedOrganizationScope, issuedAt: string): Promise<Value> => {
      try {
        if (!sameId(scope.organizationId, organization.data)) throw new PublicationContextRefused();
        const context = await readHumanContext(transaction, scope, session, issuedAt);
        const authority = createBuilderAuthority({ transaction, scope, targetFacts });
        await requireBuilderAuthority(authority, { kind: "draft_change", rootId: command.rootId });
        const initial = await readApplicationDefinitionDraft(transaction, scope, command);
        const clocks = await transaction.query<DatabaseRow>`select pg_catalog.clock_timestamp() as started_at`;
        const started = timestampSchema.safeParse(databaseTimestamp(clocks[0]?.started_at));
        if (clocks.length !== 1 || !started.success) throw new PublicationContextRefused();
        const service = createDatabaseDefinitionPublicationService(dependencies.catalogue, transaction, authority);
        let value: Value;
        if (mode === "prepare") {
          const preparation = prepareDefinitionPublicationResultSchema.parse(await service.prepare(context, command));
          if (!sameId(preparation.confirmation.rootId, initial.rootId) ||
            preparation.confirmation.expectedDraftRevision !== initial.draftRevision ||
            preparation.confirmation.sourceFingerprint !== initial.sourceFingerprint)
            throw new DefinitionPublicationError("DEFINITION_SOURCE_EVIDENCE_MISMATCH");
          value = { kind: "prepared", preparation };
        } else {
          if (!publish?.success) throw new PublicationContextRefused();
          const publication = publishDefinitionResultSchema.parse(await service.publish(context, publish.data));
          const expected = publish.data.confirmation;
          if (!sameId(publication.rootId, initial.rootId) ||
            publication.releaseRevision !== initial.draftRevision ||
            publication.releaseVersion !== expected.assignedVersion ||
            publication.contentFingerprint !== expected.contentFingerprint ||
            publication.resolutionFingerprint !== expected.resolutionFingerprint ||
            publication.comparisonFingerprint !== expected.comparisonFingerprint ||
            canonicalJson(publication.dependencyManifest) !== canonicalJson(expected.dependencyManifest) ||
            !sameId(publication.publishedBy, scope.organizationAccountId) ||
            Date.parse(publication.publishedAt) < Date.parse(started.data))
            throw new DefinitionPublicationError("DEFINITION_PUBLICATION_FAILED");
          value = { kind: "published", publication };
        }
        const final = await readApplicationDefinitionDraft(transaction, scope, command);
        if (!sameId(final.rootId, initial.rootId) || !sameId(final.organizationId, initial.organizationId) ||
          final.key !== initial.key || final.draftRevision !== initial.draftRevision ||
          final.sourceFingerprint !== initial.sourceFingerprint ||
          canonicalJson(final.source) !== canonicalJson(initial.source) ||
          final.createdAt !== initial.createdAt || !sameId(final.createdBy, initial.createdBy) ||
          final.updatedAt !== initial.updatedAt || !sameId(final.updatedBy, initial.updatedBy) ||
          final.publishedRevision !== (value.kind === "published" ? value.publication.releaseRevision : initial.publishedRevision))
          throw new DefinitionPublicationError("DEFINITION_SOURCE_EVIDENCE_MISMATCH");
        await targetFacts(transaction, scope, command.rootId);
        const completion = await readHumanContext(transaction, scope, session, issuedAt);
        if (canonicalJson(completion) !== canonicalJson(context)) throw new PublicationContextRefused();
        await assertLiveCompletion(transaction, completion,
          value.kind === "published" ? value.publication.publishedAt : undefined);
        return value;
      } catch (error) {
        failure = safeFailure(error);
        if (error instanceof BuilderAuthorityError &&
          (error.code === "BUILDER_PERMISSION_REFUSED" ||
            error.code === "BUILDER_RECENT_AUTHENTICATION_REQUIRED"))
          throw new ExpectedBuilderPublicationRefusal();
        // Throw through runChange: even a post-append result mismatch must roll back.
        throw error;
      }
    };
    const result = mode === "publish"
      ? await dependencies.requests.runChange(session, { organizationId: organization.data }, operation)
      : await dependencies.requests.run(session, { organizationId: organization.data }, operation);
    if (result.kind === "available") return { kind: "available", value: result.value };
    return failure ?? (result.kind === "unavailable" ? { kind: "refused" } : { kind: "temporarily_unavailable" });
  };
  return Object.freeze({
    prepare: async (session: IdentitySession, organizationId: string, candidate: unknown):
      Promise<HumanApplicationPublicationPreparationResult> => {
      const result = await execute(session, organizationId, candidate, "prepare");
      return result.kind !== "available" ? result : result.value.kind === "prepared"
        ? { kind: "available", preparation: result.value.preparation } : { kind: "temporarily_unavailable" };
    },
    publish: async (session: IdentitySession, organizationId: string, candidate: unknown):
      Promise<HumanApplicationPublicationResult> => {
      const result = await execute(session, organizationId, candidate, "publish");
      return result.kind !== "available" ? result : result.value.kind === "published"
        ? { kind: "available", publication: result.value.publication } : { kind: "temporarily_unavailable" };
    },
  });
};
