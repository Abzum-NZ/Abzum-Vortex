import "server-only";

import {
  actionDefinitionSchema,
  executeNamedActionResultSchema,
  type ExecuteNamedActionResult,
  moduleValidationContractVersion,
  permissionIdSchema,
  recordTypeDefinitionSchema,
} from "../schema";
import { revision } from "./save-record";
import type { NamedActionCreateTarget, PreparedNamedAction } from "./action-flow-effects";
import type { DatabaseRow } from "../db/index";

export type ResultRow = DatabaseRow & { readonly value: unknown };

export type PreparedAction = PreparedNamedAction &
  Readonly<{
    outcome: "prepared" | "previewed";
    readableFieldIds: ReadonlySet<string>;
    changeableFieldIds: ReadonlySet<string>;
    eventDescriptorCount: number;
    correlationId: string;
    singleRequiredPermissionId?: string;
    /** The exact release's compiled before-save rules for the subject, unparsed. */
    beforeSaveFlows?: unknown;
    copyTargets: readonly Readonly<{
      recordId: string;
      existingValues: Readonly<Record<string, unknown>>;
      submittedValues: Readonly<Record<string, unknown>>;
    }>[];
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

const parseCreateTargets = (candidate: unknown): readonly NamedActionCreateTarget[] | undefined => {
  if (!Array.isArray(candidate)) return undefined;
  const targets: NamedActionCreateTarget[] = [];
  for (const entry of candidate) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const value = entry as Record<string, unknown>;
    const recordType = recordTypeDefinitionSchema.safeParse(value.recordType);
    if (
      !recordType.success ||
      recordType.data.systemProjection !== undefined ||
      typeof value.ordinal !== "number" ||
      !Number.isSafeInteger(value.ordinal) ||
      value.ordinal < 0 ||
      typeof value.recordTypeId !== "string" ||
      value.recordTypeId.toLowerCase() !== recordType.data.recordTypeId.toLowerCase()
    )
      return undefined;
    targets.push({
      ordinal: value.ordinal,
      recordTypeId: recordType.data.recordTypeId,
      recordType: recordType.data,
      beforeSaveFlows: value.beforeSaveFlows,
    });
  }
  return targets.every(
    (target, index) => index === 0 || target.ordinal > targets[index - 1]!.ordinal,
  )
    ? targets
    : undefined;
};

const parseCopyTargets = (candidate: unknown, recordType: PreparedNamedAction["recordType"]) => {
  if (!Array.isArray(candidate)) return undefined;
  const targets: Array<{
    recordId: string;
    existingValues: Record<string, unknown>;
    submittedValues: Record<string, unknown>;
  }> = [];
  const fieldIds = new Set(recordType.fields.map((field) => field.fieldId.toLowerCase()));
  for (const entry of candidate) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const value = entry as Record<string, unknown>;
    if (
      typeof value.recordId !== "string" ||
      typeof value.existingValues !== "object" ||
      value.existingValues === null ||
      Array.isArray(value.existingValues) ||
      typeof value.submittedValues !== "object" ||
      value.submittedValues === null ||
      Array.isArray(value.submittedValues)
    )
      return undefined;
    const recordId = value.recordId;
    const existingValues = { ...(value.existingValues as Record<string, unknown>) };
    const submittedValues = value.submittedValues as Record<string, unknown>;
    if (
      Object.keys(submittedValues).length === 0 ||
      Object.keys(submittedValues).some((fieldId) => !fieldIds.has(fieldId.toLowerCase())) ||
      targets.some((target) => target.recordId.toLowerCase() === recordId.toLowerCase())
    )
      return undefined;
    for (const field of recordType.fields) {
      if (
        !field.required &&
        field.type !== "reference_number" &&
        field.type !== "calculation" &&
        field.type !== "total" &&
        existingValues[field.fieldId] === null
      )
        delete existingValues[field.fieldId];
    }
    targets.push({ recordId, existingValues, submittedValues });
  }
  return targets;
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
  const createTargets = parseCreateTargets(value.createTargets);
  const copyTargets = recordType.success
    ? parseCopyTargets(value.copyTargets, recordType.data)
    : undefined;
  // An action that targets a registered protected operation, and every action of a system
  // projection record type, runs through that operation's owning service, never through ordered
  // record tasks.
  if (
    !action.success ||
    action.data.protectedOperation !== undefined ||
    !recordType.success ||
    recordType.data.systemProjection !== undefined ||
    createTargets === undefined ||
    copyTargets === undefined ||
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
    createTargets,
    copyTargets,
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
