import "server-only";

import {
  previewRecordReadCommandV1Schema,
  previewRecordReadResultV1Schema,
  saveRecordCommandV2Schema,
  type IdentitySession,
  type OrganizationSelectionCandidate,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { createHumanOrganizationRequestService } from "@vortex/access";
import { createRecordSaveService, type RecordSaveServiceDependencies } from "./save-record";

type ReadRow = DatabaseRow & { readonly result: unknown };

const one = <Row>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("PREVIEW_RECORD_READ_INVALID");
  return rows[0];
};

const setPreviewInstallation = async (
  transaction: RequestDatabaseTransaction,
  previewInstallationId: string,
): Promise<void> => {
  await transaction.query`
    select pg_catalog.set_config(
      'vortex_record.preview_installation_id',
      ${previewInstallationId},
      true
    )
  `;
};

/** The owner-only record port for one unexpired preview installation. */
export const createPreviewRecordPort = (dependencies: RecordSaveServiceDependencies) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const saves = createRecordSaveService(dependencies);

  return Object.freeze({
    async read(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ) {
      const command = previewRecordReadCommandV1Schema.safeParse(commandCandidate);
      if (!command.success || selection.applicationRootId === undefined)
        return { kind: "unavailable" as const };

      return requests.run(session, selection, async (transaction) => {
        await transaction.query`set local role vortex_request`;
        await setPreviewInstallation(transaction, command.data.previewInstallationId);
        const rows = await transaction.query<ReadRow>`
          select vortex_record.read_record(
            ${command.data.recordTypeId}::uuid,
            ${command.data.recordId}::uuid
          ) as result
        `;
        return previewRecordReadResultV1Schema.parse(one(rows).result);
      });
    },

    async save(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ) {
      const command = saveRecordCommandV2Schema.safeParse(commandCandidate);
      if (
        !command.success ||
        command.data.previewInstallationId === undefined ||
        selection.applicationRootId === undefined
      )
        return { kind: "unavailable" as const };
      return saves.save(session, selection, command.data);
    },
  });
};

export type PreviewRecordPort = ReturnType<typeof createPreviewRecordPort>;
