import {
  readPageSubjectInTransaction,
  createSqlFileReadRepository,
  projectReadOnlyAttachmentList,
  type ReadOnlyAttachmentFileEvidence,
  decideFileRead,
  type InstalledRuntimeContext,
  type HumanOrganizationRequestDependencies,
  type PageSubjectReadResult,
} from "@web/platform-server";
import { ATTACHMENT_LIST_BLOCK_RELEASE } from "@vortex/platform/server";
import {
  recordIdSchema,
  fileIdSchema,
  type PageDefinition,
  type BlockPropertyValueContract,
  type IdentitySession,
  type OrganizationSelectionCandidate,
} from "@vortex/platform/schema";
import { humanOrganizationRequests } from "../server-composition";
import type {
  collectPlacements} from "./placement-helpers";
import {
  isRecord,
  sameId,
  first,
  pageSubjectParameter
} from "./placement-helpers";
import type { PageSubjectType, PageDataState, SearchParameters } from "./types";

export const readAttachmentListPlacement = async (input: {
  block: unknown;
  placement: ReturnType<typeof collectPlacements>[number]["placement"];
  pageDefinition: PageDefinition;
  subjectType: PageSubjectType | undefined;
  pageSubjectRecordTypeId: string | undefined;
  data: Record<string, PageDataState>;
  placementId: string;
  settings: Readonly<Record<string, BlockPropertyValueContract>>;
  context: InstalledRuntimeContext;
  parameters: SearchParameters;
  dependencies: HumanOrganizationRequestDependencies;
  session: IdentitySession;
  selection: OrganizationSelectionCandidate;
  page: Parameters<typeof collectPlacements>[0];
  adoptSubjectRead: (subject: PageSubjectReadResult) => void;
}): Promise<void> => {
  const {
    block,
    placement,
    pageDefinition,
    subjectType,
    pageSubjectRecordTypeId,
    data,
    placementId,
    settings,
    context,
    parameters,
    dependencies,
    session,
    selection,
    page,
    adoptSubjectRead,
  } = input;
  if (
    !isRecord(block) ||
    block.releaseVersion !== ATTACHMENT_LIST_BLOCK_RELEASE.releaseVersion ||
    placement.queryId !== undefined ||
    pageDefinition.type !== "detail" ||
    subjectType?.state !== "resolved" ||
    pageSubjectRecordTypeId === undefined
  ) {
    data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }
  const fieldSetting = settings.field;
  const fieldId = fieldSetting?.kind === "field_reference" ? fieldSetting.fieldId : undefined;
  const subjectModuleRootId = String(subjectType.moduleRootId);
  const subjectModuleMatches = context.releaseSet.modules.filter((module) =>
    sameId(String(module.rootId), subjectModuleRootId),
  );
  const subjectModule = subjectModuleMatches.length === 1 ? subjectModuleMatches[0] : undefined;
  const subjectRecordTypes = subjectModule?.content.recordTypes.filter((recordType) =>
    sameId(String(recordType.recordTypeId), pageSubjectRecordTypeId),
  ) ?? [];
  const subjectRecordType = subjectRecordTypes.length === 1 ? subjectRecordTypes[0] : undefined;
  const matchingFields =
    fieldId === undefined
      ? []
      : subjectRecordType?.fields.filter((field) => sameId(String(field.fieldId), fieldId)) ?? [];
  const attachmentField = matchingFields.length === 1 ? matchingFields[0] : undefined;
  if (fieldId === undefined || attachmentField?.type !== "attachment") {
    data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }
  const maximumFiles = attachmentField.settings.multiple
    ? attachmentField.settings.maxFiles
    : 1;
  const subjectId = recordIdSchema.safeParse(first(parameters[pageSubjectParameter]));
  if (maximumFiles === undefined || !subjectId.success) {
    data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }

  const currentAttachments = await humanOrganizationRequests(dependencies.identityAuthorityId).run(
    session,
    selection,
    async (transaction, scope) => {
      if (
        scope.accessVersion !== page.accessVersion ||
        !sameId(String(scope.organizationId), String(context.organizationId)) ||
        scope.applicationRootId === undefined ||
        !sameId(String(scope.applicationRootId), String(context.applicationRootId))
      )
        return { kind: "stale" as const };
      const currentSubject = await readPageSubjectInTransaction(transaction, {
        recordTypeId: pageSubjectRecordTypeId,
        recordId: subjectId.data,
      });
      if (currentSubject.kind !== "read")
        return { kind: "subject" as const, subject: currentSubject };
      const repository = createSqlFileReadRepository(transaction);
      const projection = await projectReadOnlyAttachmentList({
        owner: {
          organizationId: String(context.organizationId),
          applicationRootId: String(context.applicationRootId),
          recordTypeId: pageSubjectRecordTypeId,
          recordId: subjectId.data,
          fieldId,
        },
        subjectValues: currentSubject.row.values,
        maximumFiles,
        readFile: async (candidateFileId): Promise<ReadOnlyAttachmentFileEvidence> => {
          const parsedFileId = fileIdSchema.safeParse(candidateFileId);
          if (!parsedFileId.success) return { kind: "refused" };
          try {
            const decision = await decideFileRead(transaction, parsedFileId.data);
            if (decision.outcome !== "allowed") return { kind: "refused" };
            const file = await repository.readFile(parsedFileId.data);
            if (file === null) return { kind: "refused" };
            return {
              kind: "read",
              decision,
              metadata: {
                fileId: String(file.fileId),
                organizationId: String(file.organizationId),
                ...(file.applicationRootId === undefined
                  ? {}
                  : { applicationRootId: String(file.applicationRootId) }),
                ...(file.ownerRecordTypeId === undefined
                  ? {}
                  : { ownerRecordTypeId: String(file.ownerRecordTypeId) }),
                ...(file.ownerRecordId === undefined
                  ? {}
                  : { ownerRecordId: String(file.ownerRecordId) }),
                ...(file.ownerFieldId === undefined
                  ? {}
                  : { ownerFieldId: String(file.ownerFieldId) }),
                lifecycleState: file.lifecycleState,
                scannerResult: file.scannerResult,
                originalSafeDisplayName: file.originalSafeDisplayName,
                detectedMediaType: file.detectedMediaType,
                sizeBytes: file.sizeBytes,
              },
            };
          } catch {
            return { kind: "unavailable" };
          }
        },
      });
      return { kind: "projected" as const, subject: currentSubject, projection };
    },
  );
  if (currentAttachments.kind === "temporarily_unavailable") {
    data[placementId] = { status: "error" };
  } else if (currentAttachments.kind === "unavailable") {
    data[placementId] = { status: "refused", reason: "not_permitted" };
  } else if (currentAttachments.value.kind === "stale") {
    data[placementId] = { status: "refused", reason: "not_permitted" };
  } else if (currentAttachments.value.subject.kind === "temporarily_unavailable") {
    data[placementId] = { status: "error" };
  } else if (currentAttachments.value.kind === "subject") {
    data[placementId] = { status: "refused", reason: "not_permitted" };
  } else {
    adoptSubjectRead(currentAttachments.value.subject);
    const projection = currentAttachments.value.projection;
    data[placementId] =
      projection.kind === "ready"
        ? { status: "ready", values: projection.values }
        : projection.kind === "empty"
          ? { status: "empty" }
          : projection.kind === "unavailable"
            ? { status: "error" }
            : { status: "refused", reason: "not_permitted" };
  }
};
