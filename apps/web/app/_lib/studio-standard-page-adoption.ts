import "server-only";

import {
  applicationRootIdSchema,
  canonicalJson,
  organizationIdSchema,
  storedDefinitionDraftSchema,
  sessionContextSchema,
  sameId,
  type SessionContext,
  type StoredDefinitionSource,
  type SelectedOrganizationScope,
  type IdentitySession,
  type SourceIdentityAssignmentV3,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  BuilderAuthorityError,
  createHumanApplicationDraftWriter,
  createBuilderAuthority,
  requireBuilderAuthority,
  type BuilderTargetFactsReader,
} from "@vortex/access";
import {
  readApplicationDefinitionDraft,
  createDatabaseDefinitionPublicationRepository,
  createDatabaseDefinitionPublicationService,
  DefinitionStoreError,
  fingerprintCanonicalValue,
  readAuthenticatedApplicationPageAdoptionRelease,
  type StoredApplicationDefinitionDraft,
} from "@vortex/definition";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { humanOrganizationRequests } from "./server-composition";
import {
  buildPageAdoptionPlan,
  listPageAdoptionTargets,
  pageAdoptionCommandSchema,
  type PageAdoptionCommand,
  type PageAdoptionTargetOption,
} from "./studio-standard-page-adoption-plan";
import { installedReleaseCatalogue } from "./definition-catalogue";

type ClassificationRow = DatabaseRow & { outcome: unknown; application_origin_kind: unknown };
const targetFacts: BuilderTargetFactsReader = async (transaction, _scope, rootId) => {
  if (rootId === undefined) return { isSystemApplication: false };
  const rows = await transaction.query<ClassificationRow>`
    select outcome, application_origin_kind
    from vortex_definition.read_builder_application_root_classification(${rootId}::uuid)
  `;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row === undefined ||
    row.outcome !== "available" ||
    (row.application_origin_kind !== "ordinary" &&
      row.application_origin_kind !== "platform_system_application")
  )
    throw new DefinitionStoreError("DEFINITION_DRAFT_STALE_OR_MISSING");
  return { isSystemApplication: row.application_origin_kind === "platform_system_application" };
};

type ContextRow = DatabaseRow & { context: unknown };
const readCurrentHumanContext = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt?: string,
): Promise<SessionContext> => {
  const rows = await transaction.query<ContextRow>`
    select vortex_access.validated_human_request_context() as context
  `;
  const raw = rows[0]?.context;
  if (
    rows.length !== 1 ||
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    !("channel" in raw) ||
    raw.channel !== "web"
  )
    throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
  const parsed = sessionContextSchema.safeParse(
    Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "channel")),
  );
  if (!parsed.success) throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
  const context = parsed.data;
  if (
    context.callerKind !== "human" ||
    context.applicationRootId !== undefined ||
    context.delegatedContext !== undefined ||
    context.supportContext !== undefined ||
    !sameId(context.organizationId, scope.organizationId) ||
    !sameId(context.organizationAccountId, scope.organizationAccountId) ||
    context.accessVersion !== scope.accessVersion ||
    !sameId(context.tenantId, scope.tenantId) ||
    !sameId(context.identityId, session.identityId) ||
    !sameId(context.sessionId, session.sessionId) ||
    context.authenticationStrength !== session.authenticationStrength ||
    (issuedAt !== undefined && context.issuedAt !== issuedAt) ||
    context.expiresAt !== session.accessTokenExpiresAt ||
    context.accessTokenIssuedAt !==
      (session.primaryAuthenticatedAt !== undefined || session.multiFactorAuthenticatedAt !== undefined
        ? session.accessTokenIssuedAt
        : undefined) ||
    context.primaryAuthenticatedAt !== session.primaryAuthenticatedAt ||
    context.multiFactorAuthenticatedAt !== session.multiFactorAuthenticatedAt
  )
    throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
  return context;
};

const sameDraft = (
  candidate: unknown,
  current: StoredApplicationDefinitionDraft,
): boolean => {
  const parsed = storedDefinitionDraftSchema.safeParse(candidate);
  return parsed.success && canonicalJson(parsed.data) === canonicalJson(current);
};

const readCurrentCandidate = async (
  transaction: RequestDatabaseTransaction,
  context: SessionContext,
  draft: StoredApplicationDefinitionDraft,
) => {
  const candidate = await createDatabaseDefinitionPublicationRepository(transaction).read(
    context,
    (reader) => reader.readCandidate(String(draft.rootId)),
  );
  if (
    candidate === undefined ||
    candidate.draft.kind !== "application" ||
    !sameDraft(candidate.draft, draft)
  )
    throw new DefinitionStoreError("DEFINITION_DRAFT_STALE_OR_MISSING");
  return candidate;
};

const readLatestPageAdoptionRelease = async (
  transaction: RequestDatabaseTransaction,
  context: SessionContext,
  draft: StoredApplicationDefinitionDraft,
) => {
  if (draft.publishedRevision === undefined) return undefined;
  return readAuthenticatedApplicationPageAdoptionRelease(
    transaction,
    context,
    String(draft.rootId),
    draft.publishedRevision,
    draft.publishedRevision,
  );
};

const mapPageId = (
  source: StoredDefinitionSource,
  identities: readonly SourceIdentityAssignmentV3[],
  alias: string,
): string => {
  if (source.kind !== "application") throw new DefinitionStoreError("INVALID_DEFINITION_STORAGE_RESULT");
  const matches = identities.filter(
    (identity) =>
      identity.definitionKey === source.key &&
      identity.kind === "page" &&
      identity.scope === "content" &&
      identity.componentOwner === alias &&
      identity.alias === alias,
  );
  const match = matches[0];
  if (matches.length !== 1 || match === undefined) throw new DefinitionStoreError("INVALID_DEFINITION_STORAGE_RESULT");
  return match.identifier;
};

export type ComparisonChoice = Readonly<{
  original: Readonly<{ pageId: string; key: string; name: string; type: string }>;
  replacement: Readonly<{ pageId: string; key: string; name: string; type: string }>;
  candidate: Readonly<{ releaseRevision: number; releaseVersion: string; impactReasons: readonly Readonly<{ code: string; impact: string }>[] }>;
  target: PageAdoptionTargetOption;
  keepFingerprint: string;
  adoptFingerprint: string;
}>;

export type StudioStandardPageAdoptionLoadResult =
  | Readonly<{
      kind: "available";
      organizationId: string;
      rootId: string;
      draftRevision: number;
      choices: readonly ComparisonChoice[];
    }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

const toChoices = (
  draft: StoredApplicationDefinitionDraft,
  identities: readonly SourceIdentityAssignmentV3[],
  currentContent: Parameters<typeof buildPageAdoptionPlan>[0]["currentContent"],
  release: NonNullable<Awaited<ReturnType<typeof readLatestPageAdoptionRelease>>>,
): ComparisonChoice[] => {
  if (draft.source.kind !== "application") return [];
  const choices: ComparisonChoice[] = [];
  for (const replacement of draft.source.body.pages) {
    if (replacement.replaces_page === undefined) continue;
    const original = draft.source.body.pages.find((page) => page.id === replacement.replaces_page);
    if (original === undefined) continue;
    const originalPageId = mapPageId(draft.source, identities, original.id);
    const replacementPageId = mapPageId(draft.source, identities, replacement.id);
    let targets: readonly PageAdoptionTargetOption[];
    try {
      targets = listPageAdoptionTargets(
        draft,
        identities,
        currentContent,
        release,
        originalPageId,
        replacementPageId,
      );
    } catch {
      continue;
    }
    for (const target of targets) {
      try {
        const keep = buildPageAdoptionPlan({
          draft,
          currentIdentities: identities,
          currentContent,
          release,
          originalPageId,
          replacementPageId,
          target: target.target,
          decision: "keep_replacement",
        });
        const adopt = buildPageAdoptionPlan({
          draft,
          currentIdentities: identities,
          currentContent,
          release,
          originalPageId,
          replacementPageId,
          target: target.target,
          decision: "adopt_original",
        });
        choices.push({
          original: keep.original,
          replacement: keep.replacement,
          candidate: keep.candidate,
          target,
          keepFingerprint: keep.comparisonFingerprint,
          adoptFingerprint: adopt.comparisonFingerprint,
        });
      } catch {
        // An ineligible identity pair is omitted; the route never returns partial source evidence.
      }
    }
  }
  return choices;
};

export const loadStudioStandardPageAdoption = async (
  candidateOrganizationId: string,
  candidateRootId: string,
): Promise<StudioStandardPageAdoptionLoadResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const root = applicationRootIdSchema.safeParse(candidateRootId);
  if (!organization.success || !root.success) return { kind: "refused" };
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active")
      return resolved.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable" }
        : { kind: "refused" };
    const result = await humanOrganizationRequests().run(
      resolved.session,
      { organizationId: organization.data },
      async (transaction, scope, issuedAt): Promise<Readonly<{ kind: "available"; value: Omit<Extract<StudioStandardPageAdoptionLoadResult, { kind: "available" }>, "kind"> } | { kind: "refused" }>> => {
        const authority = createBuilderAuthority({ transaction, scope, targetFacts });
        try {
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId: root.data });
          const facts = await targetFacts(transaction, scope, root.data);
          if (facts.isSystemApplication) return { kind: "refused" };
        } catch (error) {
          if (error instanceof BuilderAuthorityError) return { kind: "refused" };
          throw error;
        }
        const draft = await readApplicationDefinitionDraft(transaction, scope, { rootId: root.data });
        if (draft.kind !== "application" || !sameId(draft.organizationId, scope.organizationId))
          return { kind: "refused" };
        if (draft.publishedRevision === undefined) {
          return {
            kind: "available",
            value: { organizationId: scope.organizationId, rootId: String(draft.rootId), draftRevision: draft.draftRevision, choices: [] },
          };
        }
        const context = await readCurrentHumanContext(transaction, scope, resolved.session, issuedAt);
        const current = await createDatabaseDefinitionPublicationService(
          installedReleaseCatalogue,
          transaction,
          authority,
        ).compileApplicationDraft(context, {
          rootId: String(draft.rootId),
          expectedDraftRevision: draft.draftRevision,
        });
        if (current.currentReleaseRevision !== draft.publishedRevision)
          throw new DefinitionStoreError("DEFINITION_DRAFT_STALE_OR_MISSING");
        const candidate = await readCurrentCandidate(transaction, context, draft);
        const release = await readLatestPageAdoptionRelease(transaction, context, draft);
        if (release === undefined) throw new DefinitionStoreError("DEFINITION_HISTORY_INVALID");
        const choices = toChoices(
          draft,
          candidate.identities,
          current.compilation.canonical.content,
          release,
        );
        const finalDraft = await readApplicationDefinitionDraft(transaction, scope, {
          rootId: root.data,
          expectedDraftRevision: draft.draftRevision,
        });
        await requireBuilderAuthority(authority, { kind: "draft_change", rootId: root.data });
        const finalContext = await readCurrentHumanContext(transaction, scope, resolved.session, issuedAt);
        if (
          canonicalJson(finalDraft) !== canonicalJson(draft) ||
          canonicalJson(finalContext) !== canonicalJson(context)
        )
          throw new DefinitionStoreError("DEFINITION_DRAFT_STALE_OR_MISSING");
        return {
          kind: "available",
          value: {
            organizationId: scope.organizationId,
            rootId: String(draft.rootId),
            draftRevision: draft.draftRevision,
            choices,
          },
        };
      },
    );
    if (result.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
    if (result.kind === "unavailable" || result.value.kind !== "available") return { kind: "refused" };
    return { kind: "available", ...result.value.value };
  } catch {
    return { kind: "temporarily_unavailable" };
  }
};

const sameRelease = (
  left: NonNullable<Awaited<ReturnType<typeof readLatestPageAdoptionRelease>>>,
  right: NonNullable<Awaited<ReturnType<typeof readLatestPageAdoptionRelease>>>,
): boolean =>
  left.rootId === right.rootId &&
  left.publication.revision === right.publication.revision &&
  left.publication.releaseVersion === right.publication.releaseVersion &&
  left.publication.contentFingerprint === right.publication.contentFingerprint &&
  left.compilationOutput.resolutionFingerprint === right.compilationOutput.resolutionFingerprint &&
  left.comparisonFingerprint === right.comparisonFingerprint &&
  left.authoredSourceFingerprint === right.authoredSourceFingerprint;

export const saveStudioStandardPageAdoption = async (
  organizationId: string,
  candidate: PageAdoptionCommand,
) => {
  const parsed = pageAdoptionCommandSchema.safeParse(candidate);
  if (!parsed.success) return { kind: "refused" } as const;
  const command = parsed.data;
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active")
      return resolved.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable" } as const
        : { kind: "refused" } as const;
    const writer = createHumanApplicationDraftWriter({ requests: humanOrganizationRequests() });
    return await writer.saveDerivedDraft(
      resolved.session,
      organizationId,
      command,
      async ({ transaction, scope, session, draft, command: lockedCommand }) => {
      if (
        draft.kind !== "application" ||
        !sameId(draft.rootId, lockedCommand.rootId) ||
        draft.draftRevision !== lockedCommand.expectedDraftRevision ||
        draft.publishedRevision !== lockedCommand.expectedPublicationAnchor
      )
        throw new DefinitionStoreError("DEFINITION_DRAFT_STALE_OR_MISSING");
      const context = await readCurrentHumanContext(transaction, scope, session);
      const authority = createBuilderAuthority({ transaction, scope, targetFacts });
      const facts = await targetFacts(transaction, scope, draft.rootId);
      if (facts.isSystemApplication) throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
      const current = await createDatabaseDefinitionPublicationService(
        installedReleaseCatalogue,
        transaction,
        authority,
      ).compileApplicationDraft(context, {
        rootId: String(draft.rootId),
        expectedDraftRevision: draft.draftRevision,
      });
      if (current.currentReleaseRevision !== lockedCommand.expectedPublicationAnchor)
        throw new DefinitionStoreError("DEFINITION_DRAFT_STALE_OR_MISSING");
      const candidateState = await readCurrentCandidate(transaction, context, draft);
      const release = await readLatestPageAdoptionRelease(transaction, context, draft);
      if (release === undefined) throw new DefinitionStoreError("DEFINITION_HISTORY_INVALID");
      const plan = buildPageAdoptionPlan({
        draft,
        currentIdentities: candidateState.identities,
        currentContent: current.compilation.canonical.content,
        release,
        originalPageId: lockedCommand.originalPageId,
        replacementPageId: lockedCommand.replacementPageId,
        target: lockedCommand.target,
        decision: lockedCommand.decision,
      });
      if (plan.comparisonFingerprint !== lockedCommand.comparisonFingerprint)
        throw new DefinitionStoreError("DEFINITION_DRAFT_STALE_OR_MISSING");
      return {
        source: plan.source,
        verifySaved: async (verifyTransaction, verifyScope, savedDraft) => {
          if (
            savedDraft.kind !== "application" ||
            !sameId(savedDraft.rootId, lockedCommand.rootId) ||
            savedDraft.publishedRevision !== lockedCommand.expectedPublicationAnchor
          )
            throw new DefinitionStoreError("INVALID_DEFINITION_STORAGE_RESULT");
          const verifiedContext = await readCurrentHumanContext(
            verifyTransaction,
            verifyScope,
            session,
            context.issuedAt,
          );
          if (canonicalJson(verifiedContext) !== canonicalJson(context))
            throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
          const verifiedCandidate = await createDatabaseDefinitionPublicationService(
            installedReleaseCatalogue,
            verifyTransaction,
            createBuilderAuthority({ transaction: verifyTransaction, scope: verifyScope, targetFacts }),
          ).compileApplicationDraft(verifiedContext, {
            rootId: String(savedDraft.rootId),
            expectedDraftRevision: savedDraft.draftRevision,
          });
          if (
            verifiedCandidate.currentReleaseRevision !== lockedCommand.expectedPublicationAnchor ||
            canonicalJson(verifiedCandidate.compilation.canonical.content) !== canonicalJson(plan.expectedCanonicalContent) ||
            fingerprintCanonicalValue(verifiedCandidate.compilation.canonical.content) !==
              fingerprintCanonicalValue(plan.expectedCanonicalContent)
          )
            throw new DefinitionStoreError("INVALID_DEFINITION_STORAGE_RESULT");
          const verifiedRelease = await readLatestPageAdoptionRelease(verifyTransaction, verifiedContext, savedDraft);
          if (verifiedRelease === undefined || !sameRelease(release, verifiedRelease))
            throw new DefinitionStoreError("DEFINITION_HISTORY_INVALID");
        },
      };
      },
    );
  } catch {
    return { kind: "temporarily_unavailable" } as const;
  }
};
