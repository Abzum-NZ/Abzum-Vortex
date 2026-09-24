import "server-only";

import { randomUUID } from "node:crypto";

import {
  applicationRootIdSchema,
  moduleInstallationBindingEvidenceSchema,
  moduleRootIdSchema,
  type ApplicationInstallationLifecycleResult,
  type ApplicationRootId,
  type ModuleInstallationStorageResult,
  type ModuleRootId,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

import { createApplicationInstallationLifecycleRepository } from "./installation-lifecycle";
import { createModuleInstallationStorageRepository } from "./storage-provisioning";

/**
 * The closed, lossless conversion set approved for #625. It mirrors the exact
 * catalogue constraint in
 * supabase/migrations/20260924430000_record_storage_conversion_preparation.sql,
 * so the client can only ask for a conversion the database already allows.
 */
export const storageConversionSemanticValues = [
  "integer_to_decimal",
  "integer_to_text",
  "decimal_to_text",
  "boolean_to_text",
  "uuid_to_text",
  "date_to_text",
  "date_to_timestamp_with_time_zone",
] as const;

export type StorageConversionSemantic = (typeof storageConversionSemanticValues)[number];

const databaseValueTypeValues = [
  "boolean",
  "date",
  "decimal",
  "integer",
  "json",
  "text",
  "timestamp_with_time_zone",
  "uuid",
] as const;

export type StorageConversionDatabaseValueType = (typeof databaseValueTypeValues)[number];

const planStateValues = ["planned", "converting", "converted"] as const;

export type StorageConversionPlanState = (typeof planStateValues)[number];

export type StorageConversionErrorCode =
  | "INVALID_STORAGE_CONVERSION_COMMAND"
  | "STORAGE_CONVERSION_AUTHORITY_REFUSED"
  | "STORAGE_CONVERSION_UNAVAILABLE"
  | "STORAGE_CONVERSION_CONFLICT"
  | "STORAGE_CONVERSION_INCOMPATIBLE"
  | "STORAGE_ADOPTION_DEPENDENTS_REMAIN"
  | "STORAGE_CONVERSION_FAILED";

export class StorageConversionError extends Error {
  readonly code: StorageConversionErrorCode;

  constructor(code: StorageConversionErrorCode) {
    super(code);
    this.name = "StorageConversionError";
    this.code = code;
  }
}

export interface RegisterStorageConversionCommand {
  readonly sourceStorageContractId: string;
  readonly sourceFieldId: string;
  readonly targetFieldId: string;
  readonly sourceReleaseRevision: number;
  readonly targetReleaseRevision: number;
}

export interface AllocateStorageConversionPlanCommand {
  readonly conversionContractId: string;
  readonly expectedPlanRevision: number | null;
}

export interface ConvertStorageConversionBatchCommand {
  readonly conversionContractId: string;
  readonly batchSize: number;
  readonly expectedPlanRevision: number;
}

export interface ReadStorageConversionCorrectionsCommand {
  readonly conversionContractId: string;
  readonly limit: number;
}

export interface StorageConversionRegistration {
  readonly conversionContractId: string;
  readonly storageContractId: string;
  readonly sourceFieldId: string;
  readonly targetFieldId: string;
  readonly conversionSemantic: StorageConversionSemantic;
  readonly sourceDatabaseValueType: StorageConversionDatabaseValueType;
  readonly targetDatabaseValueType: StorageConversionDatabaseValueType;
  readonly sourceReleaseRevision: number;
  readonly targetReleaseRevision: number;
  readonly changed: boolean;
}

export interface StorageAdoptionModulePin {
  readonly moduleRootId: ModuleRootId;
  readonly moduleReleaseRevision: number;
}

export interface StorageAdoptionExpectedBinding {
  readonly moduleRootId: ModuleRootId;
  readonly bindingRevision: number;
}

/**
 * Adopts one converted plan and moves the installation to the release that
 * uses the converted field. `moduleRootId` names the Module that owns the
 * converted storage, which must be one of the target pins; `active` names
 * exactly the release being left, with its binding revisions; `target` names
 * the exact release being entered and its Module pins. The database re-derives
 * and verifies every one of them against the conversion catalogue, the stored
 * dependency edges and the bindings, so none is trusted as authority.
 *
 * As for any upgrade, the Application's Access registration must already name
 * the target release (the installation coordinator aligns it in its own
 * committed transaction first), because the fixed activation requires it.
 */
export interface AdoptStorageConversionCommand {
  readonly conversionContractId: string;
  readonly expectedPlanRevision: number;
  readonly applicationRootId: ApplicationRootId;
  readonly moduleRootId: ModuleRootId;
  readonly active: {
    readonly applicationReleaseRevision: number;
    readonly expectedModuleBindings: readonly StorageAdoptionExpectedBinding[];
  };
  readonly target: {
    readonly applicationReleaseRevision: number;
    readonly modulePins: readonly StorageAdoptionModulePin[];
  };
}

export interface StorageAdoptionResult {
  readonly conversionContractId: string;
  readonly storageContractId: string;
  readonly moduleRootId: string;
  readonly sourceFieldId: string;
  readonly targetFieldId: string;
  readonly organisationId: string;
  readonly applicationRootId: string;
  readonly sourceReleaseRevision: number;
  readonly targetReleaseRevision: number;
  readonly planRevision: number;
  readonly changed: boolean;
  readonly installation: ApplicationInstallationLifecycleResult;
}

export interface StorageConversionPlanSummary {
  readonly conversionContractId: string;
  readonly storageContractId: string;
  readonly sourceFieldId: string;
  readonly targetFieldId: string;
  readonly conversionSemantic: StorageConversionSemantic;
  readonly sourceDatabaseValueType: StorageConversionDatabaseValueType;
  readonly targetDatabaseValueType: StorageConversionDatabaseValueType;
  readonly organisationId: string;
  readonly applicationRootId: string | null;
  readonly state: StorageConversionPlanState;
  readonly planRevision: number;
  readonly convertedCount: number;
  readonly changed: boolean;
}

export interface StorageConversionBatchResult {
  readonly conversionContractId: string;
  readonly organisationId: string;
  readonly applicationRootId: string | null;
  readonly state: StorageConversionPlanState;
  readonly planRevision: number;
  readonly convertedCount: number;
  readonly batchConverted: number;
  readonly hasMore: boolean;
  readonly changed: boolean;
}

export interface StorageConversionCorrection {
  readonly recordId: string;
  readonly sourceConcurrencyNumber: number;
  readonly currentConcurrencyNumber: number;
}

export interface StorageConversionCorrections {
  readonly conversionContractId: string;
  readonly organisationId: string;
  readonly applicationRootId: string | null;
  readonly conversionSemantic: StorageConversionSemantic;
  readonly changedCount: number;
  readonly corrections: readonly StorageConversionCorrection[];
}

type PlanRow = DatabaseRow & { readonly conversion_plan: unknown };
type BindingsRow = DatabaseRow & { readonly bindings: unknown };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nilUuid = "00000000-0000-0000-0000-000000000000";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUuid = (value: unknown): value is string =>
  typeof value === "string" && uuidPattern.test(value) && value.toLowerCase() !== nilUuid;

const isNullableUuid = (value: unknown): value is string | null =>
  value === null || isUuid(value);

const asRevision = (value: unknown): number | undefined => {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
  if (typeof value === "bigint") {
    const candidate = Number(value);
    return Number.isSafeInteger(candidate) && candidate >= 1 ? candidate : undefined;
  }
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const candidate = Number(value);
  return Number.isSafeInteger(candidate) && candidate >= 1 ? candidate : undefined;
};

const asNonNegativeCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const asSemantic = (value: unknown): StorageConversionSemantic | undefined =>
  typeof value === "string" &&
  (storageConversionSemanticValues as readonly string[]).includes(value)
    ? (value as StorageConversionSemantic)
    : undefined;

const asDatabaseValueType = (value: unknown): StorageConversionDatabaseValueType | undefined =>
  typeof value === "string" && (databaseValueTypeValues as readonly string[]).includes(value)
    ? (value as StorageConversionDatabaseValueType)
    : undefined;

const asPlanState = (value: unknown): StorageConversionPlanState | undefined =>
  typeof value === "string" && (planStateValues as readonly string[]).includes(value)
    ? (value as StorageConversionPlanState)
    : undefined;

const parseRegistration = (value: unknown): StorageConversionRegistration => {
  if (!isRecord(value)) throw new StorageConversionError("STORAGE_CONVERSION_FAILED");
  const conversionSemantic = asSemantic(value.conversionSemantic);
  const sourceDatabaseValueType = asDatabaseValueType(value.sourceDatabaseValueType);
  const targetDatabaseValueType = asDatabaseValueType(value.targetDatabaseValueType);
  const sourceReleaseRevision = asRevision(value.sourceReleaseRevision);
  const targetReleaseRevision = asRevision(value.targetReleaseRevision);
  if (
    !isUuid(value.conversionContractId) ||
    !isUuid(value.storageContractId) ||
    !isUuid(value.sourceFieldId) ||
    !isUuid(value.targetFieldId) ||
    conversionSemantic === undefined ||
    sourceDatabaseValueType === undefined ||
    targetDatabaseValueType === undefined ||
    sourceReleaseRevision === undefined ||
    targetReleaseRevision === undefined ||
    typeof value.changed !== "boolean"
  )
    throw new StorageConversionError("STORAGE_CONVERSION_FAILED");
  return Object.freeze({
    conversionContractId: value.conversionContractId,
    storageContractId: value.storageContractId,
    sourceFieldId: value.sourceFieldId,
    targetFieldId: value.targetFieldId,
    conversionSemantic,
    sourceDatabaseValueType,
    targetDatabaseValueType,
    sourceReleaseRevision,
    targetReleaseRevision,
    changed: value.changed,
  });
};

const parsePlanSummary = (value: unknown): StorageConversionPlanSummary => {
  if (!isRecord(value)) throw new StorageConversionError("STORAGE_CONVERSION_FAILED");
  const conversionContractId = value.conversionContractId;
  const storageContractId = value.storageContractId;
  const sourceFieldId = value.sourceFieldId;
  const targetFieldId = value.targetFieldId;
  const conversionSemantic = asSemantic(value.conversionSemantic);
  const sourceDatabaseValueType = asDatabaseValueType(value.sourceDatabaseValueType);
  const targetDatabaseValueType = asDatabaseValueType(value.targetDatabaseValueType);
  const organisationId = value.organisationId;
  const planRevision = asRevision(value.planRevision);
  const convertedCount = asNonNegativeCount(value.convertedCount);
  if (
    !isUuid(conversionContractId) ||
    !isUuid(storageContractId) ||
    !isUuid(sourceFieldId) ||
    !isUuid(targetFieldId) ||
    conversionSemantic === undefined ||
    sourceDatabaseValueType === undefined ||
    targetDatabaseValueType === undefined ||
    !isUuid(organisationId) ||
    !isNullableUuid(value.applicationRootId) ||
    asPlanState(value.state) === undefined ||
    planRevision === undefined ||
    convertedCount === undefined ||
    typeof value.changed !== "boolean"
  )
    throw new StorageConversionError("STORAGE_CONVERSION_FAILED");
  return Object.freeze({
    conversionContractId,
    storageContractId,
    sourceFieldId,
    targetFieldId,
    conversionSemantic,
    sourceDatabaseValueType,
    targetDatabaseValueType,
    organisationId,
    applicationRootId: value.applicationRootId as string | null,
    state: value.state as StorageConversionPlanState,
    planRevision,
    convertedCount,
    changed: value.changed,
  });
};

const parseBatchResult = (value: unknown): StorageConversionBatchResult => {
  if (!isRecord(value)) throw new StorageConversionError("STORAGE_CONVERSION_FAILED");
  const conversionContractId = value.conversionContractId;
  const organisationId = value.organisationId;
  const planRevision = asRevision(value.planRevision);
  const convertedCount = asNonNegativeCount(value.convertedCount);
  const batchConverted = asNonNegativeCount(value.batchConverted);
  if (
    !isUuid(conversionContractId) ||
    !isUuid(organisationId) ||
    !isNullableUuid(value.applicationRootId) ||
    asPlanState(value.state) === undefined ||
    planRevision === undefined ||
    convertedCount === undefined ||
    batchConverted === undefined ||
    typeof value.hasMore !== "boolean" ||
    typeof value.changed !== "boolean"
  )
    throw new StorageConversionError("STORAGE_CONVERSION_FAILED");
  return Object.freeze({
    conversionContractId,
    organisationId,
    applicationRootId: value.applicationRootId as string | null,
    state: value.state as StorageConversionPlanState,
    planRevision,
    convertedCount,
    batchConverted,
    hasMore: value.hasMore,
    changed: value.changed,
  });
};

const parseCorrections = (value: unknown): StorageConversionCorrections => {
  if (!isRecord(value)) throw new StorageConversionError("STORAGE_CONVERSION_FAILED");
  const conversionContractId = value.conversionContractId;
  const organisationId = value.organisationId;
  const conversionSemantic = asSemantic(value.conversionSemantic);
  const changedCount = asNonNegativeCount(value.changedCount);
  const rawCorrections = value.corrections;
  if (
    !isUuid(conversionContractId) ||
    !isUuid(organisationId) ||
    !isNullableUuid(value.applicationRootId) ||
    conversionSemantic === undefined ||
    changedCount === undefined ||
    !Array.isArray(rawCorrections)
  )
    throw new StorageConversionError("STORAGE_CONVERSION_FAILED");
  const corrections: StorageConversionCorrection[] = [];
  for (const candidate of rawCorrections) {
    if (!isRecord(candidate)) throw new StorageConversionError("STORAGE_CONVERSION_FAILED");
    const recordId = candidate.recordId;
    const sourceConcurrencyNumber = asRevision(candidate.sourceConcurrencyNumber);
    const currentConcurrencyNumber = asRevision(candidate.currentConcurrencyNumber);
    if (
      !isUuid(recordId) ||
      sourceConcurrencyNumber === undefined ||
      currentConcurrencyNumber === undefined
    )
      throw new StorageConversionError("STORAGE_CONVERSION_FAILED");
    corrections.push(
      Object.freeze({ recordId, sourceConcurrencyNumber, currentConcurrencyNumber }),
    );
  }
  return Object.freeze({
    conversionContractId,
    organisationId,
    applicationRootId: value.applicationRootId as string | null,
    conversionSemantic,
    changedCount,
    corrections: Object.freeze(corrections),
  });
};

const parseAdoptionRow = (value: unknown): Omit<StorageAdoptionResult, "installation"> => {
  if (!isRecord(value)) throw new StorageConversionError("STORAGE_CONVERSION_FAILED");
  const sourceReleaseRevision = asRevision(value.sourceReleaseRevision);
  const targetReleaseRevision = asRevision(value.targetReleaseRevision);
  const planRevision = asRevision(value.planRevision);
  const dependentCount = asNonNegativeCount(value.dependentCount);
  if (
    !isUuid(value.conversionContractId) ||
    !isUuid(value.storageContractId) ||
    !isUuid(value.moduleRootId) ||
    !isUuid(value.sourceFieldId) ||
    !isUuid(value.targetFieldId) ||
    !isUuid(value.organisationId) ||
    !isUuid(value.applicationRootId) ||
    sourceReleaseRevision === undefined ||
    targetReleaseRevision === undefined ||
    planRevision === undefined ||
    // Retirement is only ever committed with no remaining dependent.
    dependentCount !== 0 ||
    typeof value.changed !== "boolean"
  )
    throw new StorageConversionError("STORAGE_CONVERSION_FAILED");
  return Object.freeze({
    conversionContractId: value.conversionContractId,
    storageContractId: value.storageContractId,
    moduleRootId: value.moduleRootId,
    sourceFieldId: value.sourceFieldId,
    targetFieldId: value.targetFieldId,
    organisationId: value.organisationId,
    applicationRootId: value.applicationRootId,
    sourceReleaseRevision,
    targetReleaseRevision,
    planRevision,
    changed: value.changed,
  });
};

const byRootId = <Value extends { readonly moduleRootId: string }>(
  values: readonly Value[],
): Value[] =>
  [...values].sort((left, right) =>
    left.moduleRootId < right.moduleRootId ? -1 : left.moduleRootId > right.moduleRootId ? 1 : 0,
  );

const hasDistinctRoots = (values: readonly { readonly moduleRootId: string }[]): boolean =>
  new Set(values.map((value) => value.moduleRootId)).size === values.length;

const validateAdoptCommand = (
  candidate: AdoptStorageConversionCommand,
): AdoptStorageConversionCommand | undefined => {
  if (!isRecord(candidate) || !isRecord(candidate.active) || !isRecord(candidate.target))
    return undefined;
  const expectedPlanRevision = asRevision(candidate.expectedPlanRevision);
  const activeRevision = asRevision(candidate.active.applicationReleaseRevision);
  const targetRevision = asRevision(candidate.target.applicationReleaseRevision);
  const rawBindings: unknown = candidate.active.expectedModuleBindings;
  const rawPins: unknown = candidate.target.modulePins;
  if (
    !isUuid(candidate.conversionContractId) ||
    !isUuid(candidate.applicationRootId) ||
    expectedPlanRevision === undefined ||
    activeRevision === undefined ||
    targetRevision === undefined ||
    // Adoption enters a strictly newer Application release.
    targetRevision <= activeRevision ||
    !Array.isArray(rawBindings) ||
    rawBindings.length < 1 ||
    rawBindings.length > 10_000 ||
    !Array.isArray(rawPins) ||
    rawPins.length < 1 ||
    rawPins.length > 10_000
  )
    return undefined;
  const applicationRootId = applicationRootIdSchema.safeParse(
    candidate.applicationRootId.toLowerCase(),
  );
  const convertedModuleRootId = moduleRootIdSchema.safeParse(
    typeof candidate.moduleRootId === "string" ? candidate.moduleRootId.toLowerCase() : undefined,
  );
  if (!applicationRootId.success || !convertedModuleRootId.success) return undefined;
  const expectedModuleBindings: StorageAdoptionExpectedBinding[] = [];
  for (const binding of rawBindings as readonly unknown[]) {
    if (!isRecord(binding)) return undefined;
    const bindingRevision = asRevision(binding.bindingRevision);
    const moduleRootId = moduleRootIdSchema.safeParse(
      typeof binding.moduleRootId === "string" ? binding.moduleRootId.toLowerCase() : undefined,
    );
    if (!moduleRootId.success || bindingRevision === undefined) return undefined;
    expectedModuleBindings.push({ moduleRootId: moduleRootId.data, bindingRevision });
  }
  const modulePins: StorageAdoptionModulePin[] = [];
  for (const pin of rawPins as readonly unknown[]) {
    if (!isRecord(pin)) return undefined;
    const moduleReleaseRevision = asRevision(pin.moduleReleaseRevision);
    const moduleRootId = moduleRootIdSchema.safeParse(
      typeof pin.moduleRootId === "string" ? pin.moduleRootId.toLowerCase() : undefined,
    );
    if (!moduleRootId.success || moduleReleaseRevision === undefined) return undefined;
    modulePins.push({ moduleRootId: moduleRootId.data, moduleReleaseRevision });
  }
  if (
    !hasDistinctRoots(expectedModuleBindings) ||
    !hasDistinctRoots(modulePins) ||
    // The converted Module is entered at its pinned release.
    !modulePins.some((pin) => pin.moduleRootId === convertedModuleRootId.data)
  )
    return undefined;
  return Object.freeze({
    conversionContractId: candidate.conversionContractId,
    expectedPlanRevision,
    applicationRootId: applicationRootId.data,
    moduleRootId: convertedModuleRootId.data,
    active: Object.freeze({
      applicationReleaseRevision: activeRevision,
      expectedModuleBindings: Object.freeze(byRootId(expectedModuleBindings)),
    }),
    target: Object.freeze({
      applicationReleaseRevision: targetRevision,
      modulePins: Object.freeze(byRootId(modulePins)),
    }),
  });
};

const parseCommandRevision = (value: unknown): number | undefined => asRevision(value);

const parseNullableRevision = (value: unknown): number | null | undefined => {
  if (value === null || value === undefined) return null;
  return asRevision(value);
};

const validateRegisterCommand = (
  candidate: RegisterStorageConversionCommand,
): RegisterStorageConversionCommand | undefined => {
  if (!isRecord(candidate)) return undefined;
  const sourceReleaseRevision = parseCommandRevision(candidate.sourceReleaseRevision);
  const targetReleaseRevision = parseCommandRevision(candidate.targetReleaseRevision);
  if (
    !isUuid(candidate.sourceStorageContractId) ||
    !isUuid(candidate.sourceFieldId) ||
    !isUuid(candidate.targetFieldId) ||
    candidate.sourceFieldId === candidate.targetFieldId ||
    sourceReleaseRevision === undefined ||
    targetReleaseRevision === undefined ||
    targetReleaseRevision <= sourceReleaseRevision
  )
    return undefined;
  return Object.freeze({
    sourceStorageContractId: candidate.sourceStorageContractId,
    sourceFieldId: candidate.sourceFieldId,
    targetFieldId: candidate.targetFieldId,
    sourceReleaseRevision,
    targetReleaseRevision,
  });
};

const validateAllocateCommand = (
  candidate: AllocateStorageConversionPlanCommand,
): AllocateStorageConversionPlanCommand | undefined => {
  if (!isRecord(candidate)) return undefined;
  const expectedPlanRevision = parseNullableRevision(candidate.expectedPlanRevision);
  if (!isUuid(candidate.conversionContractId) || expectedPlanRevision === undefined)
    return undefined;
  return Object.freeze({
    conversionContractId: candidate.conversionContractId,
    expectedPlanRevision,
  });
};

const validateBatchCommand = (
  candidate: ConvertStorageConversionBatchCommand,
): ConvertStorageConversionBatchCommand | undefined => {
  if (!isRecord(candidate)) return undefined;
  const expectedPlanRevision = parseCommandRevision(candidate.expectedPlanRevision);
  const batchSize = candidate.batchSize;
  if (
    !isUuid(candidate.conversionContractId) ||
    expectedPlanRevision === undefined ||
    typeof batchSize !== "number" ||
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 10000
  )
    return undefined;
  return Object.freeze({
    conversionContractId: candidate.conversionContractId,
    batchSize,
    expectedPlanRevision,
  });
};

const validateCorrectionsCommand = (
  candidate: ReadStorageConversionCorrectionsCommand,
): ReadStorageConversionCorrectionsCommand | undefined => {
  if (!isRecord(candidate)) return undefined;
  const limit = candidate.limit;
  if (
    !isUuid(candidate.conversionContractId) ||
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000
  )
    return undefined;
  return Object.freeze({ conversionContractId: candidate.conversionContractId, limit });
};

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const mapFailure = (error: unknown): StorageConversionError => {
  if (error instanceof StorageConversionError) return error;
  switch (databaseCode(error)) {
    case "22023":
      return new StorageConversionError("INVALID_STORAGE_CONVERSION_COMMAND");
    case "42501":
      return new StorageConversionError("STORAGE_CONVERSION_AUTHORITY_REFUSED");
    case "P0002":
      return new StorageConversionError("STORAGE_CONVERSION_UNAVAILABLE");
    case "40001":
    case "40P01":
      return new StorageConversionError("STORAGE_CONVERSION_CONFLICT");
    case "55006":
      return new StorageConversionError("STORAGE_ADOPTION_DEPENDENTS_REMAIN");
    case "23514":
    case "55000":
      return new StorageConversionError("STORAGE_CONVERSION_INCOMPATIBLE");
    default:
      return new StorageConversionError("STORAGE_CONVERSION_FAILED");
  }
};

const singlePlanRow = (rows: readonly PlanRow[]): unknown => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new StorageConversionError("STORAGE_CONVERSION_FAILED");
  return rows[0].conversion_plan;
};

/**
 * The current revision of every binding of one Application, including a
 * detached binding of a Module the release being left does not pin, so each
 * target pin is provisioned against the exact binding it replaces.
 */
const readBindingRevisions = async (
  transaction: RequestDatabaseTransaction,
  organizationId: string,
  applicationRootId: ApplicationRootId,
): Promise<Map<string, number>> => {
  let rows: readonly BindingsRow[];
  try {
    rows = await transaction.query<BindingsRow>`
      select vortex_module.read_application_installation_bindings(
        ${applicationRootId}::uuid
      ) as bindings
    `;
  } catch (error) {
    throw mapFailure(error);
  }
  const value = rows.length === 1 ? rows[0]?.bindings : undefined;
  if (
    !isRecord(value) ||
    typeof value.organizationId !== "string" ||
    value.organizationId.toLowerCase() !== organizationId.toLowerCase() ||
    typeof value.applicationRootId !== "string" ||
    value.applicationRootId.toLowerCase() !== applicationRootId ||
    !Array.isArray(value.moduleBindings)
  )
    throw new StorageConversionError("STORAGE_CONVERSION_FAILED");
  const revisions = new Map<string, number>();
  for (const candidate of value.moduleBindings as readonly unknown[]) {
    const binding = moduleInstallationBindingEvidenceSchema.safeParse(candidate);
    if (
      !binding.success ||
      binding.data.organizationId.toLowerCase() !== organizationId.toLowerCase() ||
      binding.data.applicationRootId.toLowerCase() !== applicationRootId ||
      revisions.has(binding.data.moduleRootId.toLowerCase())
    )
      throw new StorageConversionError("STORAGE_CONVERSION_FAILED");
    revisions.set(binding.data.moduleRootId.toLowerCase(), binding.data.bindingRevision);
  }
  return revisions;
};

/** The one adoption operation: recheck the plan, count dependents and switch. */
const adoptConvertedPlan = async (
  transaction: RequestDatabaseTransaction,
  command: AdoptStorageConversionCommand,
): Promise<Omit<StorageAdoptionResult, "installation">> => {
  try {
    const rows = await transaction.query<PlanRow>`
      select vortex_record.adopt_storage_conversion(
        ${command.conversionContractId}::uuid,
        ${command.expectedPlanRevision}::bigint,
        ${command.applicationRootId}::uuid,
        ${command.moduleRootId}::uuid
      ) as conversion_plan
    `;
    return parseAdoptionRow(singlePlanRow(rows));
  } catch (error) {
    throw mapFailure(error);
  }
};

export interface StorageConversionRepository {
  registerPlan(
    command: RegisterStorageConversionCommand,
  ): Promise<StorageConversionRegistration>;
  allocatePlan(
    command: AllocateStorageConversionPlanCommand,
  ): Promise<StorageConversionPlanSummary>;
  convertBatch(
    command: ConvertStorageConversionBatchCommand,
  ): Promise<StorageConversionBatchResult>;
  readCorrections(
    command: ReadStorageConversionCorrectionsCommand,
  ): Promise<StorageConversionCorrections>;
  adopt(command: AdoptStorageConversionCommand): Promise<StorageAdoptionResult>;
}

/**
 * Calls only the fixed Record-owned storage-conversion operations. The supplied
 * transaction already carries the trusted human request context, so neither SQL,
 * physical names nor identities are inputs. Registration, allocation, batches
 * and corrections never activate a `planned` target mapping; `adopt` is the one
 * operation that does, and only together with the release change.
 */
export const createStorageConversionRepository = (
  transaction: RequestDatabaseTransaction,
): StorageConversionRepository =>
  Object.freeze({
    async registerPlan(commandCandidate: RegisterStorageConversionCommand) {
      const command = validateRegisterCommand(commandCandidate);
      if (command === undefined)
        throw new StorageConversionError("INVALID_STORAGE_CONVERSION_COMMAND");
      try {
        const rows = await transaction.query<PlanRow>`
          select vortex_record.register_storage_conversion_plan(
            ${command.sourceStorageContractId}::uuid,
            ${command.sourceFieldId}::uuid,
            ${command.targetFieldId}::uuid,
            ${command.sourceReleaseRevision}::bigint,
            ${command.targetReleaseRevision}::bigint
          ) as conversion_plan
        `;
        return parseRegistration(singlePlanRow(rows));
      } catch (error) {
        throw mapFailure(error);
      }
    },

    async allocatePlan(commandCandidate: AllocateStorageConversionPlanCommand) {
      const command = validateAllocateCommand(commandCandidate);
      if (command === undefined)
        throw new StorageConversionError("INVALID_STORAGE_CONVERSION_COMMAND");
      try {
        const rows = await transaction.query<PlanRow>`
          select vortex_record.allocate_storage_conversion_plan(
            ${command.conversionContractId}::uuid,
            ${command.expectedPlanRevision}::bigint
          ) as conversion_plan
        `;
        return parsePlanSummary(singlePlanRow(rows));
      } catch (error) {
        throw mapFailure(error);
      }
    },

    async convertBatch(commandCandidate: ConvertStorageConversionBatchCommand) {
      const command = validateBatchCommand(commandCandidate);
      if (command === undefined)
        throw new StorageConversionError("INVALID_STORAGE_CONVERSION_COMMAND");
      try {
        const rows = await transaction.query<PlanRow>`
          select vortex_record.convert_record_storage_batch(
            ${command.conversionContractId}::uuid,
            ${command.batchSize}::integer,
            ${command.expectedPlanRevision}::bigint
          ) as conversion_plan
        `;
        return parseBatchResult(singlePlanRow(rows));
      } catch (error) {
        throw mapFailure(error);
      }
    },

    async readCorrections(commandCandidate: ReadStorageConversionCorrectionsCommand) {
      const command = validateCorrectionsCommand(commandCandidate);
      if (command === undefined)
        throw new StorageConversionError("INVALID_STORAGE_CONVERSION_COMMAND");
      try {
        const rows = await transaction.query<PlanRow>`
          select vortex_record.read_storage_conversion_corrections(
            ${command.conversionContractId}::uuid,
            ${command.limit}::integer
          ) as conversion_plan
        `;
        return parseCorrections(singlePlanRow(rows));
      } catch (error) {
        throw mapFailure(error);
      }
    },

    /**
     * Atomically adopts a converted plan: detaches the installation from the
     * release it leaves, prepares storage for every pinned Module of the new
     * release in canonical Module order, switches the target mapping to active
     * and the source mapping to retired immediately before the converted
     * Module's pin is prepared, and activates the new release through the fixed
     * lifecycle operation, whose lifecycle-policy and index-readiness gates
     * apply unchanged. Adopting at the converted Module's place in that order
     * keeps every storage-lineage lock in the provisioner's canonical order.
     *
     * Every step runs on the supplied request transaction and any refusal
     * throws. As for an activation, the caller must abandon (roll back) the
     * transaction on a throw, which leaves the prior mappings and the prior
     * release active. Lifecycle and storage-provisioning refusals keep their own
     * typed errors; adoption refusals are `StorageConversionError`. Retirement
     * is a mapping state change only; no column is dropped.
     */
    async adopt(commandCandidate: AdoptStorageConversionCommand) {
      const command = validateAdoptCommand(commandCandidate);
      if (command === undefined)
        throw new StorageConversionError("INVALID_STORAGE_CONVERSION_COMMAND");

      const lifecycle = createApplicationInstallationLifecycleRepository(transaction);
      const storage = createModuleInstallationStorageRepository(transaction);

      // 1. Leave the current release, so no installation of this scope still
      //    uses the source field when it is retired. Its organisation Access
      //    lock also holds every other request of the organisation until commit.
      const detached = await lifecycle.detach({
        applicationRootId: command.applicationRootId,
        applicationReleaseRevision: command.active.applicationReleaseRevision,
        expectedModuleBindings: [...command.active.expectedModuleBindings],
      });
      if (
        detached.state !== "detached" ||
        detached.applicationRootId.toLowerCase() !== command.applicationRootId ||
        detached.applicationReleaseRevision !== command.active.applicationReleaseRevision
      )
        throw new StorageConversionError("STORAGE_CONVERSION_FAILED");
      const revisions = await readBindingRevisions(
        transaction,
        detached.organizationId,
        command.applicationRootId,
      );

      // 2. Prepare storage for the new release's pins in canonical Module
      //    order. Immediately before the converted Module, recheck the plan and
      //    switch the mappings, or refuse whole; the provisioner then accepts the
      //    converted Module's target release only because the switch was made.
      let adopted: Omit<StorageAdoptionResult, "installation"> | undefined;
      const provisioned: ModuleInstallationStorageResult[] = [];
      for (const pin of command.target.modulePins) {
        if (pin.moduleRootId === command.moduleRootId) {
          const switched = await adoptConvertedPlan(transaction, command);
          if (
            switched.conversionContractId.toLowerCase() !==
              command.conversionContractId.toLowerCase() ||
            switched.applicationRootId.toLowerCase() !== command.applicationRootId ||
            switched.moduleRootId.toLowerCase() !== command.moduleRootId ||
            switched.organisationId.toLowerCase() !== detached.organizationId.toLowerCase() ||
            switched.planRevision !== command.expectedPlanRevision
          )
            throw new StorageConversionError("STORAGE_CONVERSION_FAILED");
          // The release entered must carry exactly the converted field's release.
          if (pin.moduleReleaseRevision !== switched.targetReleaseRevision)
            throw new StorageConversionError("STORAGE_CONVERSION_INCOMPATIBLE");
          adopted = switched;
        }

        const result = await storage.provision({
          applicationRootId: command.applicationRootId,
          applicationReleaseRevision: command.target.applicationReleaseRevision,
          moduleRootId: pin.moduleRootId,
          moduleReleaseRevision: pin.moduleReleaseRevision,
          expectedBindingRevision: revisions.get(pin.moduleRootId) ?? null,
        });
        if (
          result.applicationRootId.toLowerCase() !== command.applicationRootId ||
          result.moduleRootId.toLowerCase() !== pin.moduleRootId ||
          result.moduleReleaseRevision !== pin.moduleReleaseRevision ||
          result.applicationReleaseRevision !== command.target.applicationReleaseRevision
        )
          throw new StorageConversionError("STORAGE_CONVERSION_FAILED");
        provisioned.push(result);
      }
      if (adopted === undefined) throw new StorageConversionError("STORAGE_CONVERSION_FAILED");

      // 3. Enter the new release through the fixed activation and its gates.
      const activated = await lifecycle.activate({
        applicationRootId: command.applicationRootId,
        applicationReleaseRevision: command.target.applicationReleaseRevision,
        expectedModuleBindings: byRootId(
          provisioned.map((result) => ({
            moduleRootId: result.moduleRootId,
            bindingRevision: result.bindingRevision,
          })),
        ),
      });
      if (
        activated.state !== "active" ||
        activated.applicationRootId.toLowerCase() !== command.applicationRootId ||
        activated.applicationReleaseRevision !== command.target.applicationReleaseRevision
      )
        throw new StorageConversionError("STORAGE_CONVERSION_FAILED");
      if (activated.changed)
        await transaction.query`
          select vortex_module.record_application_installation_outcome(
            ${randomUUID()}::uuid,
            ${command.applicationRootId}::uuid,
            ${command.target.applicationReleaseRevision}::bigint,
            ${"active"}::text
          )
        `;

      return Object.freeze({ ...adopted, installation: activated });
    },
  });
