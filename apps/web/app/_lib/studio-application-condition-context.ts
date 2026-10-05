import "server-only";

import { createBuilderAuthority, type BuilderTargetFactsReader } from "@vortex/access";
import { applicationRootIdSchema, organizationIdSchema, revisionSchema,
  sessionContextSchema, type IdentitySession, type SelectedOrganizationScope,
  type SessionContext } from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { BuilderAuthorityError, DefinitionStoreError, DefinitionPublicationError,
  createDatabaseDefinitionPublicationService, fingerprintCanonicalValue,
  readApplicationDefinitionDraft, requireBuilderAuthority } from "@vortex/definition";
import type { StudioApplicationConditionContextResult } from "@vortex/studio";
import { z } from "zod";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { humanOrganizationRequests } from "./server-composition";

const requestSchema = z.object({ rootId: applicationRootIdSchema,
  draftRevision: revisionSchema, pageAlias: z.string().min(1).max(160).regex(/^[a-z][a-z0-9_]*$/) }).strict();
type HumanContext = Extract<SessionContext, { callerKind: "human" }>;
type ContextRow = DatabaseRow & { request_context: unknown };
type ClassificationRow = DatabaseRow & { outcome: unknown; application_origin_kind: unknown };

class ContextRefused extends Error {}

const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

/** No default classification exists for an addressed root, including an unknown root. */
const targetFacts: BuilderTargetFactsReader = async (transaction, _scope, rootId) => {
  if (rootId === undefined) throw new ContextRefused();
  const rows = await transaction.query<ClassificationRow>`
    select outcome, application_origin_kind
    from vortex_definition.read_builder_application_root_classification(${rootId}::uuid)
  `;
  const row = rows[0];
  if (rows.length !== 1 || row === undefined || row.outcome !== "available" ||
    (row.application_origin_kind !== "ordinary" &&
      row.application_origin_kind !== "platform_system_application"))
    throw new ContextRefused();
  return { isSystemApplication: row.application_origin_kind === "platform_system_application" };
};

/** Reads the original database context; only its trusted transport channel is projected away. */
const readHumanContext = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
): Promise<HumanContext> => {
  const rows = await transaction.query<ContextRow>`
    select vortex_access.validated_human_request_context() as request_context
  `;
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) throw new ContextRefused();
  const transport = z.record(z.string(), z.unknown()).safeParse(row.request_context);
  if (!transport.success || transport.data.channel !== "web") throw new ContextRefused();
  const parsed = sessionContextSchema.safeParse(Object.fromEntries(
    Object.entries(transport.data).filter(([key]) => key !== "channel"),
  ));
  if (!parsed.success || parsed.data.callerKind !== "human") throw new ContextRefused();
  const context = parsed.data;
  const now = Date.now();
  const from = Date.parse(context.issuedAt);
  const until = Date.parse(context.expiresAt);
  if (Object.hasOwn(scope, "applicationRootId") || Object.hasOwn(context, "applicationRootId") ||
    context.delegatedContext !== undefined || context.supportContext !== undefined ||
    !sameUuid(context.tenantId, scope.tenantId) ||
    !sameUuid(context.organizationId, scope.organizationId) ||
    !sameUuid(context.organizationAccountId, scope.organizationAccountId) ||
    context.accessVersion !== scope.accessVersion ||
    !sameUuid(context.identityId, session.identityId) ||
    !sameUuid(context.sessionId, session.sessionId) ||
    context.authenticationStrength !== session.authenticationStrength ||
    context.issuedAt !== issuedAt || context.expiresAt !== session.accessTokenExpiresAt ||
    context.accessTokenIssuedAt !== (session.primaryAuthenticatedAt !== undefined ||
      session.multiFactorAuthenticatedAt !== undefined ? session.accessTokenIssuedAt : undefined) ||
    context.primaryAuthenticatedAt !== session.primaryAuthenticatedAt ||
    context.multiFactorAuthenticatedAt !== session.multiFactorAuthenticatedAt ||
    !Number.isFinite(now) || !Number.isFinite(from) || !Number.isFinite(until) ||
    from > now || until <= now || from >= until)
    throw new ContextRefused();
  return context;
};

const safeFailure = (error: unknown): StudioApplicationConditionContextResult => {
  if ((error instanceof DefinitionStoreError || error instanceof DefinitionPublicationError) &&
    error.code === "DEFINITION_DRAFT_STALE_OR_MISSING") return { kind: "conflict" };
  if (error instanceof ContextRefused || error instanceof BuilderAuthorityError ||
    (error instanceof DefinitionStoreError &&
      (error.code === "DEFINITION_CONTEXT_REFUSED" || error.code === "DEFINITION_ROOT_MISSING")))
    return { kind: "refused" };
  return { kind: "temporarily_unavailable" };
};

/** An authenticated exact saved draft read; browser input never supplies metadata or authority. */
export const readSavedStudioApplicationConditionContext = async (
  session: IdentitySession, candidateOrganizationId: string, candidate: unknown,
): Promise<StudioApplicationConditionContextResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const parsed = requestSchema.safeParse(candidate);
  if (!organization.success || !parsed.success) return { kind: "refused" };
  const request = parsed.data;
  try {
    const result = await humanOrganizationRequests().run(session, { organizationId: organization.data },
      async (transaction, scope, issuedAt): Promise<StudioApplicationConditionContextResult> => {
        try {
          if (!sameUuid(scope.organizationId, organization.data)) throw new ContextRefused();
          const context = await readHumanContext(transaction, scope, session, issuedAt);
          const authority = createBuilderAuthority({ transaction, scope, targetFacts });
          const operation = { kind: "draft_change" as const, rootId: request.rootId };
          await requireBuilderAuthority(authority, operation);
          const command = { rootId: request.rootId, expectedDraftRevision: request.draftRevision };
          const initial = await readApplicationDefinitionDraft(transaction, scope, command);
          const pages = initial.source.body.pages.filter((page) => page.id === request.pageAlias);
          const page = pages[0];
          if (pages.length !== 1 || page?.type !== "detail") return { kind: "refused" };
          const compiler = createDatabaseDefinitionPublicationService(installedReleaseCatalogue, transaction, authority);
          const output = await compiler.compileApplicationDraft(context, command);
          const envelope = output.compilation.canonical.envelope;
          if (!sameUuid(envelope.rootId, initial.rootId) ||
            !sameUuid(envelope.organizationId, initial.organizationId) || envelope.key !== initial.key ||
            envelope.draftRevision !== initial.draftRevision || envelope.publishedRevision !== initial.publishedRevision ||
            envelope.createdAt !== initial.createdAt || !sameUuid(envelope.createdBy, initial.createdBy) ||
            envelope.updatedAt !== initial.updatedAt || !sameUuid(envelope.updatedBy, initial.updatedBy) ||
            output.currentReleaseRevision !== (initial.publishedRevision ?? null) ||
            !sameUuid(output.compilation.artifact.rootId, initial.rootId) ||
            output.compilation.artifact.definitionKey !== initial.key ||
            output.compilation.artifact.resolutionFingerprint !== output.compilation.resolutionFingerprint ||
            output.compilation.artifact.contentFingerprint !== fingerprintCanonicalValue(output.compilation.canonical.content))
            return { kind: "conflict" };
          const matches = output.conditionContexts.filter((item) => item.pageAlias === page.id &&
            item.recordReference === page.record_type);
          const metadata = matches[0];
          if (matches.length !== 1 || metadata === undefined ||
            !sameUuid(metadata.module.organizationId, scope.organizationId)) return { kind: "temporarily_unavailable" };
          if (metadata.sourceFingerprint !== initial.sourceFingerprint ||
            metadata.bindingsSignature !== JSON.stringify(initial.source.body.module_bindings)) return { kind: "conflict" };
          if (metadata.bindingsSignature.length > 100_000 || JSON.stringify(metadata).length > 999_000)
            return { kind: "temporarily_unavailable" };
          const final = await readApplicationDefinitionDraft(transaction, scope, command);
          if (!sameUuid(final.rootId, initial.rootId) || !sameUuid(final.organizationId, initial.organizationId) ||
            final.key !== initial.key || final.draftRevision !== initial.draftRevision ||
            final.sourceFingerprint !== initial.sourceFingerprint || final.publishedRevision !== initial.publishedRevision ||
            final.createdAt !== initial.createdAt || !sameUuid(final.createdBy, initial.createdBy) ||
            final.updatedAt !== initial.updatedAt || !sameUuid(final.updatedBy, initial.updatedBy) ||
            fingerprintCanonicalValue(final.source) !== fingerprintCanonicalValue(initial.source)) return { kind: "conflict" };
          await requireBuilderAuthority(authority, operation);
          const completion = await readHumanContext(transaction, scope, session, issuedAt);
          if (!sameUuid(completion.identityAuthorityId, context.identityAuthorityId) ||
            !sameUuid(completion.correlationId, context.correlationId)) throw new ContextRefused();
          return { kind: "available", context: {
            organizationId: scope.organizationId, rootId: initial.rootId, key: initial.key,
            draftRevision: initial.draftRevision,
            publishedRevision: initial.publishedRevision ?? null, createdAt: initial.createdAt, updatedAt: initial.updatedAt,
            resolutionFingerprint: output.compilation.resolutionFingerprint, ...metadata,
          } };
        } catch (error) { return safeFailure(error); }
      });
    return result.kind === "available" ? result.value : result.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" } : { kind: "refused" };
  } catch { return { kind: "temporarily_unavailable" }; }
};
