import "server-only";

import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

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
      return new StorageConversionError("STORAGE_CONVERSION_CONFLICT");
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
}

/**
 * Calls only the four fixed Record-owned storage-conversion operations. The
 * supplied transaction already carries the trusted human request context, so
 * neither SQL, physical names nor identities are inputs. A `planned` target
 * mapping is never activated here; the atomic switch and retirement belong to
 * #626.
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
  });
