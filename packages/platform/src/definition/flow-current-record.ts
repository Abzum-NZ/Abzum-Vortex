import "server-only";

import type {
  IdentitySession,
  OrganizationSelectionCandidate,
  SelectedOrganizationScope,
} from "../access/identity-access";
import { recordIdSchema, recordTypeIdSchema } from "../catalogue/identifiers";
import { sameId } from "../catalogue/runtime-primitives";
import type { HumanOrganizationRequestResult } from "../access/human-organization-request";
import type { RequestDatabaseTransaction } from "../db/request-transaction";
import type { ViewerSafeRecordLinkReadService } from "../queries/viewer-safe-record-link-read";
import { flowRuntimeValueOf } from "../rules/flow-runtime-value";
import type { InstalledFlowBindings } from "./flow-binding-endpoint";
import type { FlowCurrentRecordRead } from "./flow-orchestrator-types";

/**
 * Reads the record an interactive flow runs for: the one way a flow reads the record a page
 * shows or a card that was moved. The read is the protected Record projection under the
 * initiator's current access, behind the exact installation the flow was resolved from, so the
 * field-level read policy applies: a field the initiator may not read reads as empty. Each field
 * is keyed by its key and typed by its field type, exactly as a named action's flow reads its
 * subject. Nothing here is authority; a record the initiator may not read is unavailable.
 */

type RequestRunner = Readonly<{
  run: <Result>(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    operation: (
      transaction: RequestDatabaseTransaction,
      scope: SelectedOrganizationScope,
    ) => Promise<Result>,
  ) => Promise<HumanOrganizationRequestResult<Result>>;
}>;

const unavailable: FlowCurrentRecordRead = Object.freeze({ outcome: "unavailable" });

export const createFlowCurrentRecordReader = (
  dependencies: Readonly<{
    requests: RequestRunner;
    reader: Pick<ViewerSafeRecordLinkReadService, "readValues">;
    installation: InstalledFlowBindings;
    /** The verified initiator the installation was read for; a read for anyone else is refused. */
    identityId: string;
  }>,
) =>
  Object.freeze({
    read: async (
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      target: Readonly<{ recordTypeId: string; recordId: string }>,
    ): Promise<FlowCurrentRecordRead> => {
      const { installation } = dependencies;
      const recordTypeId = recordTypeIdSchema.safeParse(target.recordTypeId);
      const recordId = recordIdSchema.safeParse(target.recordId);
      if (
        !recordTypeId.success ||
        !recordId.success ||
        !sameId(session.identityId, dependencies.identityId) ||
        !sameId(selection.organizationId, installation.organizationId) ||
        selection.applicationRootId === undefined ||
        !sameId(selection.applicationRootId, installation.applicationRootId)
      )
        return unavailable;
      // The record type of exactly one installed Module release names its fields and storage.
      const owners = (installation.modules ?? []).flatMap((module) =>
        module.content.recordTypes
          .filter((recordType) => sameId(recordType.recordTypeId, recordTypeId.data))
          .map((recordType) => ({ module, recordType })),
      );
      const owner = owners.length === 1 ? owners[0] : undefined;
      if (owner === undefined) {
        console.error(
          `[flows] the record type ${recordTypeId.data} of a flow's record is installed ${owners.length} times`,
        );
        return unavailable;
      }
      const result = await dependencies.requests.run(session, selection, (transaction, scope) =>
        dependencies.reader.readValues(transaction, scope, {
          identity: {
            organizationId: installation.organizationId,
            applicationRootId: installation.applicationRootId,
            moduleRootId: owner.module.rootId,
            moduleReleaseRevision: owner.module.releaseRevision,
            recordTypeId: recordTypeId.data,
            storageContractId: owner.recordType.storageContractId,
            recordId: recordId.data,
          },
          applicationReleaseRevision: installation.installationRevision,
        }),
      );
      if (result.kind !== "available" || result.value.outcome !== "read") return unavailable;
      const stored = result.value.values;
      const readable = (fieldId: string) =>
        Object.entries(stored).find(([candidate]) => sameId(candidate, fieldId))?.[1] ?? null;
      return {
        outcome: "read",
        values: Object.fromEntries(
          owner.recordType.fields.map((field) => [
            String(field.key),
            flowRuntimeValueOf(
              field.type,
              readable(String(field.fieldId)),
              field.type === "calculation" || field.type === "total"
                ? field.settings.resultType
                : undefined,
            ),
          ]),
        ),
      };
    },
  });
