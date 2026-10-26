import "server-only";

import type { SelectedOrganizationScope } from "../../access/identity-access";
import { organizationRecordAccessDeclarationSchema } from "../../access/organization-access-decision";
import { permissionActionKindSchema, type PermissionActionKind } from "../../access/permissions";
import { sameId } from "../../catalogue/runtime-primitives";
import type { RequestDatabaseTransaction } from "../../db/request-transaction";
import { evaluateOrganizationRecordPermissionAvailability } from "../../access/organization-record-permission-availability";
import type { InstalledRuntimeContext } from "../../definition/installed-runtime-context";

/** A standard record permission the decision reads; the feature keys are never permission actions. */
type AccessAction = PermissionActionKind;

/**
 * The standard permissions of one record type the viewer holds now, each decided on its own,
 * without a row, through the record permission availability the record decisions start from.
 * Returns the installed permission entries that are eligible, with the record type they decide.
 */
const eligibleEntries = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  context: InstalledRuntimeContext,
  recordTypeId: string,
  action: AccessAction,
) => {
  const entries = context.permissionRegistration.entries.filter(
    (entry) =>
      entry.permission.actionKind === action &&
      entry.permission.namedAction === undefined &&
      entry.permission.recordTypeId !== undefined &&
      sameId(String(entry.permission.recordTypeId), recordTypeId),
  );
  const targets = context.releaseSet.modules.flatMap((module) =>
    module.content.recordTypes
      .filter((record) => sameId(String(record.recordTypeId), recordTypeId))
      .map((record) => ({ module, record })),
  );
  const target = targets.length === 1 ? targets[0] : undefined;
  if (target === undefined) return [];
  const eligible: typeof entries = [];
  for (const entry of entries) {
    const availability = await evaluateOrganizationRecordPermissionAvailability(
      transaction,
      scope,
      organizationRecordAccessDeclarationSchema.parse({
        operationKey: `application.page.record_fields.${action}`,
        action: { actionKind: action },
        target: { kind: "application", applicationRootId: context.applicationRootId },
        requiredPermissions: [
          {
            applicationRootId: entry.applicationRootId,
            ownerKind: entry.ownerKind,
            ownerId: entry.ownerId,
            permissionId: entry.permission.permissionId,
          },
        ],
        recordBinding: {
          moduleRootId: target.module.rootId,
          recordTypeId: target.record.recordTypeId,
          storageContractId: target.record.storageContractId,
          storageScope: target.record.storageScope,
        },
        recentAuthentication: { kind: "none" },
        authority: { kind: "permission" },
      }),
    );
    if (availability.outcome === "eligible") eligible.push(entry);
  }
  return eligible;
};

/**
 * The fields the viewer may set when they create a record of one type: the union of the changeable
 * fields of the eligible standard create permissions. The readable columns are decided in the
 * database by access route (`readRecordTypeVisibleFieldIds`).
 */
export const decideRecordTypeCreatableFieldIds = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  context: InstalledRuntimeContext,
  recordTypeId: string,
): Promise<ReadonlySet<string>> => {
  const fieldIds = new Set<string>();
  for (const entry of await eligibleEntries(
    transaction,
    scope,
    context,
    recordTypeId,
    permissionActionKindSchema.enum.create,
  ))
    for (const fieldId of entry.permission.fieldPolicy?.changeableFieldIds ?? [])
      fieldIds.add(String(fieldId).toLowerCase());
  return fieldIds;
};

/** Why a viewer may not export a record type now. */
type RecordTypeExportRefusal = "export_not_permitted" | "export_scope_not_all_records";

/**
 * Whether the viewer may export one record type now, and which fields the export permission
 * lets them write to a file. Export is decided for the record type, not per row, so it is offered
 * only when an eligible export permission reaches all records; an export permission limited to
 * owned or shared records is refused rather than widened to every record the viewer reads.
 * `fieldIds` is absent when an eligible permission leaves its fields unrestricted.
 */
export const decideRecordTypeExport = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  context: InstalledRuntimeContext,
  recordTypeId: string,
): Promise<
  | Readonly<{ kind: "permitted"; fieldIds: ReadonlySet<string> | undefined }>
  | Readonly<{ kind: "refused"; reason: RecordTypeExportRefusal }>
> => {
  const eligible = await eligibleEntries(
    transaction,
    scope,
    context,
    recordTypeId,
    permissionActionKindSchema.enum.export,
  );
  if (eligible.length === 0) return { kind: "refused", reason: "export_not_permitted" };
  const reaching = eligible.filter(
    (entry) =>
      entry.permission.recordScope?.routes.some((route) => route.kind === "all_records") === true,
  );
  if (reaching.length === 0) return { kind: "refused", reason: "export_scope_not_all_records" };
  if (reaching.some((entry) => entry.permission.fieldPolicy === undefined))
    return { kind: "permitted", fieldIds: undefined };
  return {
    kind: "permitted",
    fieldIds: new Set(
      reaching.flatMap((entry) =>
        (entry.permission.fieldPolicy?.readableFieldIds ?? []).map((fieldId) =>
          String(fieldId).toLowerCase(),
        ),
      ),
    ),
  };
};
