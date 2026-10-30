import "server-only";

import { permissionIdSchema } from "../catalogue/identifiers";
import {
  actionDefinitionSchema,
  moduleValidationContractVersion,
  recordTypeDefinitionSchema,
} from "../definition/module-contracts";
import { executeNamedActionResultSchema, type ExecuteNamedActionResult } from "./named-actions";
import { revision } from "./save-record";
import type { PreparedNamedAction } from "./named-action-inputs";
import type { DatabaseRow } from "../db/request-transaction";

export type ResultRow = DatabaseRow & { readonly value: unknown };

type PreparedAction = PreparedNamedAction &
  Readonly<{
    outcome: "prepared" | "previewed";
    readableFieldIds: ReadonlySet<string>;
    changeableFieldIds: ReadonlySet<string>;
    eventDescriptorCount: number;
    correlationId: string;
    singleRequiredPermissionId?: string;
    /** The exact release's compiled before-save rules for the subject, unparsed. */
    beforeSaveFlows?: unknown;
  }>;

export type ActionPreparation =
  | PreparedAction
  | Readonly<{ outcome: "completed"; result: ExecuteNamedActionResult }>
  | Readonly<{
      outcome: "conflict" | "permission_refused" | "refused" | "refused_recorded" | "unsupported";
      correlationId?: string;
      reasonCode?: string;
    }>;

export const one = <Row>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("NAMED_ACTION_RESULT_INVALID");
  return rows[0];
};

export const completedResult = (candidate: Record<string, unknown>) => {
  const parsedRevision = revision(candidate.concurrencyNumber);
  if (parsedRevision === undefined) return undefined;
  const result = executeNamedActionResultSchema.safeParse({
    contractVersion: "2.0.0",
    outcome: "completed",
    recordId: candidate.recordId,
    concurrencyNumber: parsedRevision,
    readableValues: candidate.values,
    correlationId: candidate.correlationId,
    backgroundDelivery: candidate.backgroundDelivery,
  });
  return result.success ? result.data : undefined;
};

export const parsePreparation = (candidate: unknown): ActionPreparation => {
  if (typeof candidate !== "object" || candidate === null) return { outcome: "refused" };
  const value = candidate as Record<string, unknown>;
  const correlationId = typeof value.correlationId === "string" ? value.correlationId : undefined;
  if (value.outcome === "completed") {
    const result = completedResult(value);
    return result === undefined
      ? { outcome: "refused", ...(correlationId ? { correlationId } : {}) }
      : { outcome: "completed", result };
  }
  if (
    value.outcome === "conflict" ||
    value.outcome === "permission_refused" ||
    value.outcome === "refused" ||
    value.outcome === "refused_recorded" ||
    value.outcome === "unsupported"
  )
    return {
      outcome: value.outcome,
      ...(correlationId ? { correlationId } : {}),
      ...(typeof value.reasonCode === "string" ? { reasonCode: value.reasonCode } : {}),
    };
  if (value.outcome !== "prepared" && value.outcome !== "previewed")
    return { outcome: "refused", ...(correlationId ? { correlationId } : {}) };
  const singleRequiredPermissionId =
    value.singleRequiredPermissionId === null || value.singleRequiredPermissionId === undefined
      ? undefined
      : permissionIdSchema.safeParse(value.singleRequiredPermissionId);
  if (singleRequiredPermissionId !== undefined && !singleRequiredPermissionId.success)
    return { outcome: "refused", ...(correlationId ? { correlationId } : {}) };
  const action = actionDefinitionSchema.safeParse(value.action);
  const recordType = recordTypeDefinitionSchema.safeParse(value.recordType);
  // An action that targets a registered protected operation, and every action of a system
  // projection record type, runs through that operation's owning service, never through an
  // action flow.
  if (
    !action.success ||
    action.data.protectedOperation !== undefined ||
    !recordType.success ||
    recordType.data.systemProjection !== undefined ||
    value.validationContractVersion !== moduleValidationContractVersion ||
    typeof value.recordId !== "string" ||
    typeof value.existingValues !== "object" ||
    value.existingValues === null ||
    Array.isArray(value.existingValues) ||
    typeof value.actorOrganizationAccountId !== "string" ||
    !Array.isArray(value.readableFieldIds) ||
    !Array.isArray(value.changeableFieldIds) ||
    !Array.isArray(value.eventDescriptors) ||
    correlationId === undefined
  )
    return { outcome: "refused", ...(correlationId ? { correlationId } : {}) };
  // Ordinary storage reads represent unset optional columns as null. The field
  // candidate treats absence as unset, as the base save preparation does.
  const existingValues = { ...(value.existingValues as Record<string, unknown>) };
  for (const field of recordType.data.fields) {
    if (
      !field.required &&
      field.type !== "reference_number" &&
      field.type !== "calculation" &&
      field.type !== "total" &&
      existingValues[field.fieldId] === null
    )
      delete existingValues[field.fieldId];
  }
  return {
    outcome: value.outcome,
    validationContractVersion: moduleValidationContractVersion,
    action: action.data,
    recordType: recordType.data,
    recordId: value.recordId,
    existingValues,
    actorOrganizationAccountId: value.actorOrganizationAccountId,
    readableFieldIds: new Set(
      value.readableFieldIds.filter((item): item is string => typeof item === "string"),
    ),
    changeableFieldIds: new Set(
      value.changeableFieldIds.filter((item): item is string => typeof item === "string"),
    ),
    eventDescriptorCount: value.eventDescriptors.length,
    correlationId,
    ...(singleRequiredPermissionId === undefined
      ? {}
      : { singleRequiredPermissionId: singleRequiredPermissionId.data }),
    ...(value.beforeSaveFlows === undefined ? {} : { beforeSaveFlows: value.beforeSaveFlows }),
  };
};
