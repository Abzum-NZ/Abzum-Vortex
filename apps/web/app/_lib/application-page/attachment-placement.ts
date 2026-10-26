import {
  readPageSubjectInTransaction,
  readFileForDownload,
  projectReadOnlyAttachmentList,
  type ReadOnlyAttachmentFileEvidence,
  decideFileRead,
  type InstalledRuntimeContext,
  type HumanOrganizationRequestDependencies,
  type PageSubjectReadResult,
} from "@vortex/platform/server";
import { ATTACHMENT_LIST_BLOCK_RELEASE } from "@vortex/platform/server";
import {
  recordIdSchema,
  fileIdSchema,
  type PageDefinition,
  type BlockPropertyValueContract,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  isRecord,
  logRefusal,
  sameId,
} from "@vortex/platform/schema";
import { humanOrganizationRequests } from "../server-composition";
import type { collectPlacements } from "./placement-helpers";
import { first, pageSubjectParameter } from "./placement-helpers";
import type { PageSubjectType, PageDataState, SearchParameters } from "./types";

export const readAttachmentListPlacement = async (input: {
  block: unknown;
  placement: ReturnType<typeof collectPlacements>[number];
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
    placement.vortex.queryId !== undefined ||
    pageDefinition.type !== "detail" ||
    subjectType?.state !== "resolved" ||
    pageSubjectRecordTypeId === undefined
  ) {
    logRefusal("page", `attachment placement ${placementId}`, "placement_shape_mismatch");
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
  const subjectRecordTypes =
    subjectModule?.content.recordTypes.filter((recordType) =>
      sameId(String(recordType.recordTypeId), pageSubjectRecordTypeId),
    ) ?? [];
  const subjectRecordType = subjectRecordTypes.length === 1 ? subjectRecordTypes[0] : undefined;
  const matchingFields =
    fieldId === undefined
      ? []
      : (subjectRecordType?.fields.filter((field) => sameId(String(field.fieldId), fieldId)) ?? []);
  const attachmentField = matchingFields.length === 1 ? matchingFields[0] : undefined;
  if (fieldId === undefined || attachmentField?.type !== "attachment") {
    logRefusal("page", `attachment placement ${placementId}`, "field_setting_not_attachment_field");
    data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }
  const maximumFiles = attachmentField.settings.multiple ? attachmentField.settings.maxFiles : 1;
  const subjectId = recordIdSchema.safeParse(first(parameters[pageSubjectParameter]));
  if (maximumFiles === undefined || !subjectId.success) {
    logRefusal(
      "page",
      `attachment placement ${placementId}`,
      maximumFiles === undefined ? "maximum_files_missing" : "page_subject_id_invalid",
    );
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
        requestedFieldIds: [fieldId],
      });
      if (currentSubject.kind !== "read")
        return { kind: "subject" as const, subject: currentSubject };
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
          if (!parsedFileId.success) {
            logRefusal("page", `attachment placement ${placementId}`, "file_id_invalid");
            return { kind: "refused" };
          }
          try {
            const decision = await decideFileRead(transaction, parsedFileId.data);
            if (decision.outcome !== "allowed") {
              logRefusal(
                "page",
                `attachment placement ${placementId}`,
                `file_read_decision_${String(decision.outcome)}`,
              );
              return { kind: "refused" };
            }
            const file = await readFileForDownload(transaction, parsedFileId.data);
            if (file === null) {
              logRefusal("page", `attachment placement ${placementId}`, "file_record_missing");
              return { kind: "refused" };
            }
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
          } catch (cause) {
            console.error(
              `[page] attachment placement unavailable: placement=${placementId} reason=file_read_failed`,
              cause,
            );
            return { kind: "unavailable" };
          }
        },
      });
      return { kind: "projected" as const, subject: currentSubject, projection };
    },
  );
  if (currentAttachments.kind === "temporarily_unavailable") {
    console.error(
      `[page] attachment placement unavailable: placement=${placementId} reason=request_temporarily_unavailable`,
    );
    data[placementId] = { status: "error" };
  } else if (currentAttachments.kind === "unavailable") {
    logRefusal("page", `attachment placement ${placementId}`, "request_scope_unavailable");
    data[placementId] = { status: "refused", reason: "not_permitted" };
  } else if (currentAttachments.value.kind === "stale") {
    logRefusal("page", `attachment placement ${placementId}`, "request_scope_stale");
    data[placementId] = { status: "refused", reason: "not_permitted" };
  } else if (currentAttachments.value.subject.kind === "temporarily_unavailable") {
    console.error(
      `[page] attachment placement unavailable: placement=${placementId} reason=subject_read_temporarily_unavailable`,
    );
    data[placementId] = { status: "error" };
  } else if (currentAttachments.value.kind === "subject") {
    logRefusal("page", `attachment placement ${placementId}`, "subject_read_refused");
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
            : (logRefusal(
                "page",
                `attachment placement ${placementId}`,
                `projection_${projection.reason}`,
              ),
              { status: "refused", reason: "not_permitted" });
  }
};
