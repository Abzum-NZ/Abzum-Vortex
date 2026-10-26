import {
  decideFileRead,
  readFileForDownload,
  formFieldOf,
  type InstalledRuntimeContext,
} from "@vortex/platform/server";
import {
  fileIdSchema,
  moduleFieldValueSchemas,
  isRecord,
  sameId,
  type IdentitySession,
} from "@vortex/platform/schema";
import { humanOrganizationRequests } from "../server-composition";
import { fieldControl, type collectPlacements } from "./placement-helpers";
import type { ApplicationPageLoaderAddress, PageDataState } from "./types";

/** Projects the upload address and readable file names under this page's ordinary request scope. */
export const projectAttachmentInputs = async (
  input: Readonly<{
    placements: ReturnType<typeof collectPlacements>;
    context: InstalledRuntimeContext;
    address: ApplicationPageLoaderAddress;
    session: IdentitySession;
    recordTypeId?: string;
    recordId?: string;
    data: Record<string, PageDataState>;
  }>,
) => {
  const recordType = input.context.releaseSet.modules
    .flatMap((module) => module.content.recordTypes)
    .find(
      (record) =>
        input.recordTypeId !== undefined && sameId(String(record.recordTypeId), input.recordTypeId),
    );
  const fields = input.placements.filter((entry) => fieldControl(entry) === "attachment");
  if (fields.length === 0 || recordType === undefined) return;
  const selection = {
    organizationId: input.context.organizationId,
    applicationRootId: input.context.applicationRootId,
  };
  const projected = await humanOrganizationRequests().run(
    input.session,
    selection,
    async (transaction) => {
      const results: Record<string, PageDataState> = {};
      for (const entry of fields) {
        const field = formFieldOf(entry, recordType);
        if (field?.type !== "attachment") throw new Error("ATTACHMENT_INPUT_FIELD_INVALID");
        const state = input.data[entry.placementId];
        if (state !== undefined && state.status !== "ready") continue;
        const payload =
          state?.status === "ready" && isRecord(state.values) ? state.values : undefined;
        const value = payload?.value ?? [];
        const ids = moduleFieldValueSchemas.attachment
          .parse(value)
          .map((id) => fileIdSchema.parse(id));
        const files = [];
        for (const id of ids) {
          const decision = await decideFileRead(transaction, id);
          if (decision.outcome !== "allowed") throw new Error("ATTACHMENT_INPUT_FILE_UNREADABLE");
          const file = await readFileForDownload(transaction, id);
          if (file === null || file.ownerFieldId !== field.fieldId)
            throw new Error("ATTACHMENT_INPUT_FILE_MISSING");
          files.push({ fileId: id, name: file.originalSafeDisplayName });
        }
        const query = new URLSearchParams({
          tenantShortName: input.address.tenantShortName,
          organizationShortName: input.address.organizationShortName,
          applicationKey: input.address.application.key,
          pageKey: input.address.pageKey,
          recordTypeId: String(recordType.recordTypeId),
          fieldId: String(field.fieldId),
          ...(input.recordId === undefined ? {} : { recordId: input.recordId }),
        });
        results[entry.placementId] = {
          status: "ready",
          values: {
            kind: "attachment_input",
            value: ids,
            files,
            uploadUrl: `/api/files/upload?${query}`,
          },
        };
      }
      return results;
    },
  );
  if (projected.kind !== "available")
    throw new Error(`ATTACHMENT_INPUT_PROJECTION_${projected.kind}`);
  Object.assign(input.data, projected.value);
};
