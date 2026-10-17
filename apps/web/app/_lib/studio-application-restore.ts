import "server-only";

import { createBuilderAuthority, type BuilderTargetFactsReader } from "@vortex/platform/server";
import {
  organizationIdSchema,
  sameId,
  type StoredDefinitionDraft,
} from "@vortex/platform/schema";
import { BuilderAuthorityError, createDatabaseDefinitionHistoryService, readLiveHumanContext, requireBuilderAuthority,
  type LiveHumanContext } from "@vortex/platform/server";
import type { DatabaseRow} from "@vortex/platform/server";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { getIdentityAuthorityConfiguration } from "../auth/_lib/authority-configuration";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { humanOrganizationRequests } from "./server-composition";
import {
  studioApplicationRestoreCommandSchema,
  studioApplicationRestoreCommandResultSchema,
  studioApplicationRestoreReceiptSchema,
  type StudioApplicationRestoreCommand,
  type StudioApplicationRestoreCommandResult,
  type StudioApplicationRestoreFailure,
  type StudioApplicationRestoreReceipt,
} from "./studio-application-restore-contracts";
import { DefinitionError, classifyDatabaseError } from "@vortex/platform/server";
import { platformPermissionSource } from "./platform-permission-source";
import { readStudioPersonLabel } from "./studio-person-labels";

type ApplicationDraft = Extract<StoredDefinitionDraft, { kind: "application" }>;
type FailureKind = StudioApplicationRestoreFailure["kind"];

class RestoreRefused extends Error {}
class RestoreUnavailable extends Error {}

const targetFacts: BuilderTargetFactsReader = async (transaction, _scope, rootId) => {
  if (rootId === undefined) throw new RestoreRefused();
  const rows = await transaction.query<DatabaseRow>`
    select outcome, application_origin_kind
    from vortex_definition.read_builder_application_root_classification(${rootId}::uuid)
  `;
  if (rows.length !== 1 || rows[0]?.outcome !== "available" ||
    rows[0]?.application_origin_kind !== "ordinary") throw new RestoreRefused();
  return { isSystemApplication: false };
};

const failureKind = (error: unknown): FailureKind => {
  const kind = classifyDatabaseError(error);
  if (error instanceof DefinitionError) {
    if (error.code === "DEFINITION_DRAFT_STALE_OR_MISSING") return "conflict";
    if (["DEFINITION_CONTEXT_REFUSED", "DEFINITION_RELEASE_NOT_FOUND", "DEFINITION_RELEASE_INTEGRITY_FAILED",
      "INVALID_DEFINITION_RESTORE_COMMAND"].includes(error.code)) return "refused";
  }
  if (error instanceof DefinitionError) {
    if (error.code === "DEFINITION_DRAFT_STALE_OR_MISSING" || kind === "conflict") return "conflict";
    if (["DEFINITION_CONTEXT_REFUSED", "DEFINITION_ROOT_MISSING", "INVALID_DEFINITION_COMMAND"].includes(error.code))
      return "refused";
  }
  if (error instanceof BuilderAuthorityError || error instanceof RestoreRefused || kind === "refused")
    return "refused";
  if (kind === "conflict") return "conflict";
  return "temporarily_unavailable";
};

const createReceipt = (
  draft: StoredDefinitionDraft,
  command: StudioApplicationRestoreCommand,
  context: LiveHumanContext,
): StudioApplicationRestoreReceipt => {
  if (draft.kind !== "application") throw new RestoreUnavailable();
  const applicationDraft: ApplicationDraft = draft;
  const restoredBy = applicationDraft.restoredBy;
  const restoredAt = applicationDraft.restoredAt;
  const restoredFromReleaseRevision = applicationDraft.restoredFromReleaseRevision;
  const restoredFromSourceFingerprint = applicationDraft.restoredFromSourceFingerprint;
  const restoreCorrelationId = applicationDraft.restoreCorrelationId;
  if (!sameId(applicationDraft.organizationId, command.selector.organizationId) ||
    !sameId(applicationDraft.rootId, command.selector.rootId) ||
    applicationDraft.draftRevision !== command.expected.draftRevision + 1 ||
    applicationDraft.publishedRevision !== command.expected.anchorReleaseRevision ||
    restoredFromReleaseRevision !== command.selector.releaseRevision ||
    restoredFromSourceFingerprint === undefined ||
    restoredFromSourceFingerprint !== applicationDraft.sourceFingerprint ||
    restoredBy === undefined || !sameId(restoredBy, context.organizationAccountId) ||
    !sameId(applicationDraft.updatedBy, context.organizationAccountId) ||
    restoredAt === undefined || applicationDraft.updatedAt !== restoredAt ||
    restoreCorrelationId === undefined || restoreCorrelationId !== context.correlationId)
    throw new RestoreUnavailable();

  const receipt = studioApplicationRestoreReceiptSchema.safeParse({
    organizationId: applicationDraft.organizationId,
    rootId: applicationDraft.rootId,
    definitionKey: applicationDraft.key,
    targetReleaseRevision: restoredFromReleaseRevision,
    draftRevision: applicationDraft.draftRevision,
    sourceFingerprint: applicationDraft.sourceFingerprint,
    publicationAnchor: applicationDraft.publishedRevision,
    restoredBy,
    restoredByLabel: { kind: "unavailable" },
    restoredAt,
    correlationId: restoreCorrelationId,
  });
  if (!receipt.success) throw new RestoreUnavailable();
  return receipt.data;
};

const failedCommand = (kind: FailureKind, invocationStarted: boolean): StudioApplicationRestoreCommandResult => ({
  kind,
  stateMayHaveChanged: invocationStarted ? "unknown" : false,
});

/** Runs one explicitly confirmed HUMAN restore and reports success only after the request commits. */
export async function restoreStudioApplicationDraft(
  organizationIdCandidate: string,
  commandCandidate: unknown,
): Promise<StudioApplicationRestoreCommandResult> {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const command = studioApplicationRestoreCommandSchema.safeParse(commandCandidate);
  if (!organizationId.success || !command.success ||
    !sameId(organizationId.data, command.data.selector.organizationId))
    return failedCommand("refused", false);

  let resolved: Awaited<ReturnType<typeof resolveIdentitySession>>;
  try {
    resolved = await resolveIdentitySession();
  } catch {
    return failedCommand("temporarily_unavailable", false);
  }
  if (resolved.kind !== "active") return failedCommand(
    resolved.kind === "temporarily_unavailable" ? "temporarily_unavailable" : "refused",
    false,
  );

  let invocationStarted = false;
  let callbackFailure: FailureKind | undefined;
  try {
    const result = await humanOrganizationRequests().runChange(
      resolved.session,
      { organizationId: command.data.selector.organizationId },
      async (transaction, scope, issuedAt): Promise<StudioApplicationRestoreCommandResult> => {
        try {
          if (!sameId(scope.organizationId, command.data.selector.organizationId) ||
            Object.hasOwn(scope, "applicationRootId")) throw new RestoreRefused();
          const context = await readLiveHumanContext(transaction, { scope, session: resolved.session, issuedAt,
            identityAuthorityId: getIdentityAuthorityConfiguration().authorityId });
          const authority = createBuilderAuthority({ transaction, scope, targetFacts, permissions: platformPermissionSource });
          await requireBuilderAuthority(authority, {
            kind: "draft_change",
            rootId: command.data.selector.rootId,
          });
          const service = createDatabaseDefinitionHistoryService(
            installedReleaseCatalogue,
            transaction,
            authority,
          );
          invocationStarted = true;
          const draft = await service.restoreDraft(context, {
            kind: "application",
            rootId: command.data.selector.rootId,
            targetReleaseRevision: command.data.selector.releaseRevision,
            expectedDraftRevision: command.data.expected.draftRevision,
            expectedSourceFingerprint: command.data.expected.sourceFingerprint,
            expectedPublicationAnchor: command.data.expected.anchorReleaseRevision,
          });
          const completed = studioApplicationRestoreCommandResultSchema.safeParse({
            kind: "completed",
            receipt: createReceipt(draft, command.data, context),
            stateMayHaveChanged: true,
          });
          if (!completed.success) throw new RestoreUnavailable();
          return completed.data;
        } catch (error) {
          callbackFailure = failureKind(error);
          throw error;
        }
      },
    );
    if (result.kind === "available") {
      if (result.value.kind !== "completed") return result.value;
      // The label is read after the restore committed, so a failed read never undoes or hides it.
      const { receipt } = result.value;
      return { ...result.value, receipt: { ...receipt,
        restoredByLabel: await readStudioPersonLabel(receipt.organizationId, receipt.restoredBy) } };
    }
    const kind = callbackFailure ?? (result.kind === "unavailable"
      ? "refused" : "temporarily_unavailable");
    return failedCommand(kind, invocationStarted);
  } catch (error) {
    return failedCommand(callbackFailure ?? failureKind(error), invocationStarted);
  }
}
