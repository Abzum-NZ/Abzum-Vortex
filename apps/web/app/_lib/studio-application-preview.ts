import "server-only";

import { createBuilderAuthority, type BuilderTargetFactsReader } from "@vortex/access";
import {
  applicationRootIdSchema,
  organizationIdSchema,
  revisionSchema,
  sessionContextSchema,
  type Fingerprint,
  type IdentitySession,
  type OrganizationId,
  type SelectedOrganizationScope,
  type SessionContext,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  applicationPreviewBreakpoints,
  BuilderAuthorityError,
  compileApplicationPreviewDraft,
  createDatabaseDefinitionPublicationService,
  DefinitionStoreError,
  fingerprintCanonicalValue,
  materialiseApplicationPreview,
  readApplicationDefinitionDraft,
  requireBuilderAuthority,
  type ApplicationPreviewArtifact,
  type ApplicationPreviewRefusalReason,
} from "@vortex/definition";
import { z } from "zod";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { humanOrganizationRequests } from "./server-composition";

const savedHomepageRequestSchema = z.object({
  rootId: applicationRootIdSchema,
  draftRevision: revisionSchema,
  breakpoint: z.enum(applicationPreviewBreakpoints),
}).strict();

export type StudioApplicationPreviewResult =
  | Readonly<{ kind: "available"; organizationId: OrganizationId; key: string;
      sourceFingerprint: Fingerprint; resolutionFingerprint: Fingerprint;
      artifact: ApplicationPreviewArtifact }>
  | Readonly<{ kind: "refused"; reason: ApplicationPreviewRefusalReason }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

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

const safeFailure = (error: unknown): StudioApplicationPreviewResult => {
  if (error instanceof DefinitionStoreError && error.code === "DEFINITION_DRAFT_STALE_OR_MISSING")
    return { kind: "conflict" };
  if (error instanceof ContextRefused || error instanceof BuilderAuthorityError ||
    (error instanceof DefinitionStoreError &&
      (error.code === "DEFINITION_CONTEXT_REFUSED" || error.code === "DEFINITION_ROOT_MISSING")))
    return { kind: "refused", reason: "context_refused" };
  return { kind: "temporarily_unavailable" };
};

/** Server-resolved session only. The action never accepts a session, source or canonical page. */
export const previewSavedStudioApplication = async (
  session: IdentitySession,
  candidateOrganizationId: string,
  candidate: unknown,
): Promise<StudioApplicationPreviewResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const parsed = savedHomepageRequestSchema.safeParse(candidate);
  if (!organization.success || !parsed.success) return { kind: "refused", reason: "invalid_request" };
  const request = { kind: "application" as const, ...parsed.data, sampleData: [] };
  try {
    const result = await humanOrganizationRequests().run(
      session, { organizationId: organization.data },
      async (transaction, scope, issuedAt): Promise<StudioApplicationPreviewResult> => {
        try {
          if (!sameUuid(scope.organizationId, organization.data)) throw new ContextRefused();
          const context = await readHumanContext(transaction, scope, session, issuedAt);
          const authority = createBuilderAuthority({ transaction, scope, targetFacts });
          const operation = { kind: "draft_change" as const, rootId: request.rootId };
          await requireBuilderAuthority(authority, operation);
          const command = { rootId: request.rootId, expectedDraftRevision: request.draftRevision };
          const initial = await readApplicationDefinitionDraft(transaction, scope, command);
          const compiler = createDatabaseDefinitionPublicationService(
            installedReleaseCatalogue, transaction, authority,
          );
          const compiled = await compileApplicationPreviewDraft(compiler, context, request);
          if (compiled.status === "refused")
            return compiled.refusal.reason === "draft_stale_or_missing"
              ? { kind: "conflict" } : { kind: "refused", reason: compiled.refusal.reason };
          const output = compiled.compiled.compilation;
          const envelope = output.canonical.envelope;
          if (!sameUuid(envelope.rootId, initial.rootId) ||
            !sameUuid(envelope.organizationId, initial.organizationId) ||
            envelope.key !== initial.key || envelope.draftRevision !== initial.draftRevision ||
            envelope.publishedRevision !== initial.publishedRevision ||
            envelope.createdAt !== initial.createdAt || !sameUuid(envelope.createdBy, initial.createdBy) ||
            envelope.updatedAt !== initial.updatedAt || !sameUuid(envelope.updatedBy, initial.updatedBy) ||
            !sameUuid(output.artifact.rootId, initial.rootId) || output.artifact.definitionKey !== initial.key ||
            output.artifact.resolutionFingerprint !== output.resolutionFingerprint ||
            output.artifact.contentFingerprint !== fingerprintCanonicalValue(output.canonical.content) ||
            compiled.compiled.currentReleaseRevision !== (initial.publishedRevision ?? null))
            return { kind: "conflict" };
          const materialised = materialiseApplicationPreview({ request, draft: compiled.draft });
          if (materialised.status === "refused")
            return { kind: "refused", reason: materialised.refusal.reason };
          const final = await readApplicationDefinitionDraft(transaction, scope, command);
          if (!sameUuid(final.rootId, initial.rootId) ||
            !sameUuid(final.organizationId, initial.organizationId) || final.key !== initial.key ||
            final.draftRevision !== initial.draftRevision || final.sourceFingerprint !== initial.sourceFingerprint ||
            final.publishedRevision !== initial.publishedRevision ||
            final.createdAt !== initial.createdAt || !sameUuid(final.createdBy, initial.createdBy) ||
            final.updatedAt !== initial.updatedAt || !sameUuid(final.updatedBy, initial.updatedBy))
            return { kind: "conflict" };
          await requireBuilderAuthority(authority, operation);
          const completion = await readHumanContext(transaction, scope, session, issuedAt);
          if (!sameUuid(completion.identityAuthorityId, context.identityAuthorityId) ||
            !sameUuid(completion.correlationId, context.correlationId))
            throw new ContextRefused();
          return { kind: "available", organizationId: scope.organizationId, key: initial.key,
            sourceFingerprint: initial.sourceFingerprint, resolutionFingerprint: output.resolutionFingerprint,
            artifact: materialised.artifact };
        } catch (error) {
          return safeFailure(error);
        }
      },
    );
    return result.kind === "available" ? result.value : result.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" } : { kind: "refused", reason: "context_refused" };
  } catch {
    return { kind: "temporarily_unavailable" };
  }
};
