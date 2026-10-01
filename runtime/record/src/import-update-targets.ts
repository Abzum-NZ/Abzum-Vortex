import "server-only";

import {
  activeApplicationInstallationEvidenceSchema,
  applicationRootIdSchema,
  correlationIdSchema,
  fieldIdSchema,
  identityIdSchema,
  identitySessionSchema,
  jsonValueSchema,
  moduleRootIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  organizationSelectionCandidateSchema,
  recordIdSchema,
  recordTypeDefinitionV3Schema,
  recordTypeIdSchema,
  revisionSchema,
  storageContractIdSchema,
  timestampSchema,
  type ActiveApplicationInstallationEvidence,
  type ApplicationRootId,
  type CorrelationId,
  type FieldId,
  type IdentityId,
  type IdentitySession,
  type JsonValue,
  type ModuleRootId,
  type OrganizationAccountId,
  type OrganizationId,
  type OrganizationSelectionCandidate,
  type RecordId,
  type RecordTypeDefinitionV3,
  type Revision,
  type StorageContractId,
} from "@vortex/contracts";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import type { DatabaseRow } from "@vortex/db";
import type { RecordImportRowAccessFact, RecordImportRowMatchFact } from "./import-preview";

const maxTargets = 50;
const maxMappedFields = 500;
const maxCandidateBytes = 256;
const maxDefinitionBytes = 256 * 1024;
const maxReadableValuesBytes = 64 * 1024;
const maxResultBytes = 5 * 1024 * 1024;
const nilUuid = "00000000-0000-0000-0000-000000000000";
const generatedFieldTypes = new Set(["reference_number", "calculation", "total"]);

export type RecordImportUpdateTargetInput = Readonly<{
  rowNumber: number;
  recordIdCandidate: string;
}>;

/** Bounded address and mapping candidates only; this input carries no authority or row values. */
export type RecordImportUpdateTargetFactsInput = Readonly<{
  recordTypeId: string;
  mappedFieldIds: readonly string[];
  targets: readonly RecordImportUpdateTargetInput[];
}>;

export type RecordImportUpdateTargetMatchedRow = Readonly<{
  rowNumber: number;
  status: "matched";
  recordId: RecordId;
  expectedConcurrencyNumber: Revision;
  existingValues: Readonly<Record<string, JsonValue>>;
  changeableFieldIds: readonly FieldId[];
  access: RecordImportRowAccessFact;
  match: Extract<RecordImportRowMatchFact, { method: "record_id"; state: "matched" }>;
}>;

export type RecordImportUpdateTargetRefusedRow = Readonly<{
  rowNumber: number;
  status: "refused";
  code: "invalid_record_id" | "target_unavailable";
}>;

export type RecordImportUpdateTargetRow =
  RecordImportUpdateTargetMatchedRow | RecordImportUpdateTargetRefusedRow;

/** Server-only partial facts. Missing uniqueness and pending checks keep this incomplete for #731. */
export type RecordImportUpdateTargetFacts = Readonly<{
  kind: "partial_update_target_facts";
  validationComplete: false;
  organizationId: OrganizationId;
  applicationRootId: ApplicationRootId;
  identityId: IdentityId;
  organizationAccountId: OrganizationAccountId;
  accessVersion: Revision;
  correlationId: CorrelationId;
  issuedAt: string;
  validUntil: string;
  activeInstallation: ActiveApplicationInstallationEvidence;
  moduleRootId: ModuleRootId;
  moduleReleaseRevision: Revision;
  storageContractId: StorageContractId;
  storageScope: "organization_shared" | "application_contained";
  recordType: RecordTypeDefinitionV3;
  mappedFieldIds: readonly FieldId[];
  rows: readonly RecordImportUpdateTargetRow[];
}>;

const isPlainDataObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && "value" in descriptor;
    });
  } catch {
    return false;
  }
};

const exactDataObject = (
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | undefined => {
  if (!isPlainDataObject(value)) return undefined;
  try {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
    )
      return undefined;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
        return undefined;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return undefined;
  }
};

const denseDataArray = (value: unknown, maximum: number): readonly unknown[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum)
      return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) return undefined;
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!ownKeys.includes(String(index))) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
        return undefined;
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return undefined;
  }
};

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const hasOnlyUnicodeScalars = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return false;
    }
  }
  return true;
};

type NormalizedInput = Readonly<{
  recordTypeId: string;
  mappedFieldIds: readonly FieldId[];
  targets: readonly Readonly<{ rowNumber: number; recordIdCandidate: string; validId: boolean }>[];
}>;

const normalizeInput = (candidate: unknown): NormalizedInput | undefined => {
  const input = exactDataObject(candidate, ["recordTypeId", "mappedFieldIds", "targets"]);
  if (input === undefined) return undefined;
  if (typeof input.recordTypeId !== "string" || input.recordTypeId.length !== 36) return undefined;
  const parsedTypeId = recordTypeIdSchema.safeParse(input.recordTypeId.toLowerCase());
  if (!parsedTypeId.success) return undefined;

  const rawMappedFieldIds = denseDataArray(input.mappedFieldIds, maxMappedFields);
  if (
    rawMappedFieldIds === undefined ||
    rawMappedFieldIds.length < 1 ||
    rawMappedFieldIds.length > maxMappedFields
  )
    return undefined;
  const mappedFieldIds: FieldId[] = [];
  const mappedSet = new Set<string>();
  for (const candidateFieldId of rawMappedFieldIds) {
    if (typeof candidateFieldId !== "string" || candidateFieldId.length !== 36) return undefined;
    const parsedFieldId = fieldIdSchema.safeParse(candidateFieldId.toLowerCase());
    if (!parsedFieldId.success || mappedSet.has(parsedFieldId.data)) return undefined;
    mappedSet.add(parsedFieldId.data);
    mappedFieldIds.push(parsedFieldId.data);
  }

  const rawTargets = denseDataArray(input.targets, maxTargets);
  if (rawTargets === undefined || rawTargets.length < 1 || rawTargets.length > maxTargets)
    return undefined;
  const seenRows = new Set<number>();
  const targets: Array<{ rowNumber: number; recordIdCandidate: string; validId: boolean }> = [];
  for (const rawTarget of rawTargets) {
    const target = exactDataObject(rawTarget, ["rowNumber", "recordIdCandidate"]);
    if (
      target === undefined ||
      typeof target.rowNumber !== "number" ||
      !Number.isSafeInteger(target.rowNumber) ||
      target.rowNumber <= 0 ||
      seenRows.has(target.rowNumber) ||
      typeof target.recordIdCandidate !== "string"
    )
      return undefined;
    if (target.recordIdCandidate.length > maxCandidateBytes) return undefined;
    if (utf8ByteLength(target.recordIdCandidate) > maxCandidateBytes) return undefined;
    seenRows.add(target.rowNumber);
    const validId = hasOnlyUnicodeScalars(target.recordIdCandidate)
      ? recordIdSchema.safeParse(target.recordIdCandidate.toLowerCase())
      : { success: false as const };
    const canonicalCandidate = validId.success ? validId.data.toLowerCase() : "";
    targets.push({
      rowNumber: target.rowNumber,
      recordIdCandidate: canonicalCandidate,
      validId: validId.success,
    });
  }
  return {
    recordTypeId: parsedTypeId.data,
    mappedFieldIds,
    targets,
  };
};

const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const sameJson = (left: unknown, right: unknown): boolean => {
  if (Array.isArray(left))
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJson(item, right[index]))
    );
  if (typeof left === "object" && left !== null) {
    if (!isPlainDataObject(left) || !isPlainDataObject(right)) return false;
    const leftEntries = Object.entries(left);
    return (
      leftEntries.length === Object.keys(right).length &&
      leftEntries.every(([key, item]) => Object.hasOwn(right, key) && sameJson(item, right[key]))
    );
  }
  return left === right;
};

const deepFreeze = <Value>(value: Value): Value => {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
};

type SqlResultRow = DatabaseRow & { readonly result: unknown };

const parseProducerResult = (
  rawValue: unknown,
  input: NormalizedInput,
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  scope: Readonly<{
    organizationId: string;
    organizationAccountId: string;
    applicationRootId?: string;
    accessVersion: number;
  }>,
  requestIssuedAt: string,
): RecordImportUpdateTargetFacts => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(rawValue);
  } catch {
    throw new Error("INVALID_IMPORT_UPDATE_TARGET_RESULT");
  }
  if (serialized === undefined || utf8ByteLength(serialized) > maxResultBytes)
    throw new Error("INVALID_IMPORT_UPDATE_TARGET_RESULT");
  const outer = exactDataObject(rawValue, [
    "outcome",
    "kind",
    "validationComplete",
    "organizationId",
    "applicationRootId",
    "identityId",
    "organizationAccountId",
    "accessVersion",
    "correlationId",
    "issuedAt",
    "validUntil",
    "activeInstallation",
    "moduleRootId",
    "moduleReleaseRevision",
    "storageContractId",
    "storageScope",
    "recordType",
    "mappedFieldIds",
    "rows",
  ]);
  if (
    outer === undefined ||
    outer.outcome !== "available" ||
    outer.kind !== "partial_update_target_facts" ||
    outer.validationComplete !== false
  )
    throw new Error("INVALID_IMPORT_UPDATE_TARGET_RESULT");

  const organizationId = organizationIdSchema.safeParse(outer.organizationId);
  const applicationRootId = applicationRootIdSchema.safeParse(outer.applicationRootId);
  const identityId = identityIdSchema.safeParse(outer.identityId);
  const organizationAccountId = organizationAccountIdSchema.safeParse(outer.organizationAccountId);
  const accessVersion = revisionSchema.safeParse(outer.accessVersion);
  const correlationId = correlationIdSchema.safeParse(outer.correlationId);
  const issuedAt = timestampSchema.safeParse(outer.issuedAt);
  const validUntil = timestampSchema.safeParse(outer.validUntil);
  const activeInstallation = activeApplicationInstallationEvidenceSchema.safeParse(
    outer.activeInstallation,
  );
  const moduleRootId = moduleRootIdSchema.safeParse(outer.moduleRootId);
  const moduleReleaseRevision = revisionSchema.safeParse(outer.moduleReleaseRevision);
  const storageContractId = storageContractIdSchema.safeParse(outer.storageContractId);
  const recordType = recordTypeDefinitionV3Schema.safeParse(outer.recordType);
  const resultFieldIds = denseDataArray(outer.mappedFieldIds, maxMappedFields);
  const resultRows = denseDataArray(outer.rows, maxTargets);
  if (
    !organizationId.success ||
    !applicationRootId.success ||
    !identityId.success ||
    !organizationAccountId.success ||
    !accessVersion.success ||
    !correlationId.success ||
    !issuedAt.success ||
    !validUntil.success ||
    !activeInstallation.success ||
    !moduleRootId.success ||
    !moduleReleaseRevision.success ||
    !storageContractId.success ||
    !recordType.success ||
    resultFieldIds === undefined ||
    resultRows === undefined ||
    (outer.storageScope !== "organization_shared" && outer.storageScope !== "application_contained")
  )
    throw new Error("INVALID_IMPORT_UPDATE_TARGET_RESULT");

  const definition = recordType.data;
  const evidence = activeInstallation.data;
  if (
    definition.systemProjection !== undefined ||
    definition.fields.length > 500 ||
    utf8ByteLength(JSON.stringify(definition)) > maxDefinitionBytes ||
    !sameUuid(definition.recordTypeId, input.recordTypeId) ||
    !sameUuid(definition.storageContractId, storageContractId.data) ||
    definition.storageScope !== outer.storageScope ||
    !sameUuid(scope.organizationId, organizationId.data) ||
    !sameUuid(scope.organizationAccountId, organizationAccountId.data) ||
    scope.applicationRootId === undefined ||
    !sameUuid(scope.applicationRootId, applicationRootId.data) ||
    !sameUuid(selection.organizationId, organizationId.data) ||
    selection.applicationRootId === undefined ||
    !sameUuid(selection.applicationRootId, applicationRootId.data) ||
    !sameUuid(session.identityId, identityId.data) ||
    scope.accessVersion !== accessVersion.data ||
    issuedAt.data !== requestIssuedAt ||
    Date.parse(validUntil.data) <= Date.parse(issuedAt.data) ||
    Date.parse(validUntil.data) > Date.parse(session.accessTokenExpiresAt) ||
    Date.parse(validUntil.data) > Date.parse(issuedAt.data) + 30_000 ||
    !sameUuid(evidence.organizationId, organizationId.data) ||
    !sameUuid(evidence.applicationRootId, applicationRootId.data) ||
    evidence.moduleBindings.filter(
      (binding) =>
        sameUuid(binding.moduleRootId, moduleRootId.data) &&
        binding.moduleReleaseRevision === moduleReleaseRevision.data &&
        binding.state === "active",
    ).length !== 1
  )
    throw new Error("INVALID_IMPORT_UPDATE_TARGET_RESULT");

  if (
    resultFieldIds.length !== input.mappedFieldIds.length ||
    resultFieldIds.some(
      (fieldId, index) =>
        typeof fieldId !== "string" || !sameUuid(fieldId, input.mappedFieldIds[index]!),
    )
  )
    throw new Error("INVALID_IMPORT_UPDATE_TARGET_RESULT");
  const fieldsById = new Map(
    definition.fields.map((field) => [field.fieldId.toLowerCase(), field]),
  );
  for (const fieldId of input.mappedFieldIds) {
    const field = fieldsById.get(fieldId.toLowerCase());
    if (field === undefined || generatedFieldTypes.has(field.type))
      throw new Error("INVALID_IMPORT_UPDATE_TARGET_RESULT");
  }

  if (resultRows.length !== input.targets.length)
    throw new Error("INVALID_IMPORT_UPDATE_TARGET_RESULT");
  const rows: RecordImportUpdateTargetRow[] = [];
  for (let index = 0; index < input.targets.length; index += 1) {
    const requested = input.targets[index]!;
    const rawRow = resultRows[index];
    const common = exactDataObject(rawRow, ["rowNumber", "status", "code"]);
    if (
      common !== undefined &&
      common.rowNumber === requested.rowNumber &&
      common.status === "refused" &&
      (common.code === "invalid_record_id" || common.code === "target_unavailable") &&
      (common.code !== "invalid_record_id" || !requested.validId) &&
      (common.code !== "target_unavailable" || requested.validId)
    ) {
      rows.push({
        rowNumber: requested.rowNumber,
        status: "refused",
        code: common.code,
      });
      continue;
    }

    const matched = exactDataObject(rawRow, [
      "rowNumber",
      "status",
      "recordId",
      "expectedConcurrencyNumber",
      "existingValues",
      "changeableFieldIds",
      "access",
      "match",
    ]);
    if (
      matched === undefined ||
      matched.rowNumber !== requested.rowNumber ||
      matched.status !== "matched"
    )
      throw new Error("INVALID_IMPORT_UPDATE_TARGET_RESULT");
    const parsedRecordId = recordIdSchema.safeParse(matched.recordId);
    const expectedConcurrencyNumber = revisionSchema.safeParse(matched.expectedConcurrencyNumber);
    const existingValues = isPlainDataObject(matched.existingValues)
      ? jsonValueSchema.safeParse(matched.existingValues)
      : { success: false as const };
    const existingValuesObject =
      existingValues.success && isPlainDataObject(existingValues.data)
        ? existingValues.data
        : undefined;
    const changeableFieldIds = denseDataArray(matched.changeableFieldIds, maxMappedFields);
    const access = exactDataObject(matched.access, ["state", "operation", "targetRecordId"]);
    const match = exactDataObject(matched.match, ["method", "state", "recordId", "existingValues"]);
    const accessTargetRecordId =
      access === undefined
        ? { success: false as const }
        : recordIdSchema.safeParse(access.targetRecordId);
    const matchRecordId =
      match === undefined ? { success: false as const } : recordIdSchema.safeParse(match.recordId);
    const readableFieldIds =
      existingValuesObject !== undefined
        ? Object.keys(existingValuesObject).map((fieldId) => fieldId.toLowerCase())
        : [];
    const readableFieldIdSet = new Set(readableFieldIds);
    if (
      !requested.validId ||
      !parsedRecordId.success ||
      !sameUuid(parsedRecordId.data, requested.recordIdCandidate) ||
      !expectedConcurrencyNumber.success ||
      !existingValues.success ||
      existingValuesObject === undefined ||
      changeableFieldIds === undefined ||
      access === undefined ||
      match === undefined ||
      !accessTargetRecordId.success ||
      !matchRecordId.success ||
      access.state !== "allowed" ||
      access.operation !== "update" ||
      !sameUuid(accessTargetRecordId.data, parsedRecordId.data) ||
      match.method !== "record_id" ||
      match.state !== "matched" ||
      !sameUuid(matchRecordId.data, parsedRecordId.data) ||
      !sameJson(match.existingValues, existingValuesObject) ||
      changeableFieldIds.length !== input.mappedFieldIds.length ||
      changeableFieldIds.some(
        (fieldId, fieldIndex) =>
          typeof fieldId !== "string" || !sameUuid(fieldId, input.mappedFieldIds[fieldIndex]!),
      ) ||
      readableFieldIds.length !== readableFieldIdSet.size ||
      input.mappedFieldIds.some((fieldId) => !readableFieldIdSet.has(fieldId.toLowerCase())) ||
      Object.keys(existingValuesObject).some((fieldId) => {
        const parsedFieldId = fieldIdSchema.safeParse(fieldId.toLowerCase());
        return !parsedFieldId.success || !fieldsById.has(parsedFieldId.data.toLowerCase());
      }) ||
      utf8ByteLength(JSON.stringify(existingValuesObject)) > maxReadableValuesBytes
    )
      throw new Error("INVALID_IMPORT_UPDATE_TARGET_RESULT");

    const values = existingValuesObject as Readonly<Record<string, JsonValue>>;
    const row: RecordImportUpdateTargetMatchedRow = {
      rowNumber: requested.rowNumber,
      status: "matched",
      recordId: parsedRecordId.data,
      expectedConcurrencyNumber: expectedConcurrencyNumber.data,
      existingValues: values,
      changeableFieldIds: input.mappedFieldIds,
      access: {
        state: "allowed",
        operation: "update",
        targetRecordId: parsedRecordId.data,
      },
      match: {
        method: "record_id",
        state: "matched",
        recordId: parsedRecordId.data,
        existingValues: values,
      },
    };
    rows.push(row);
  }

  const bundle: RecordImportUpdateTargetFacts = {
    kind: "partial_update_target_facts",
    validationComplete: false,
    organizationId: organizationId.data,
    applicationRootId: applicationRootId.data,
    identityId: identityId.data,
    organizationAccountId: organizationAccountId.data,
    accessVersion: accessVersion.data,
    correlationId: correlationId.data,
    issuedAt: issuedAt.data,
    validUntil: validUntil.data,
    activeInstallation: evidence,
    moduleRootId: moduleRootId.data,
    moduleReleaseRevision: moduleReleaseRevision.data,
    storageContractId: storageContractId.data,
    storageScope: outer.storageScope,
    recordType: definition,
    mappedFieldIds: input.mappedFieldIds,
    rows,
  };
  return deepFreeze(bundle);
};

export const createRecordImportUpdateTargetFactsService = (
  dependencies: HumanOrganizationRequestDependencies,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const clock = dependencies.clock ?? (() => new Date());

  return Object.freeze({
    async read(
      sessionCandidate: IdentitySession,
      selectionCandidate: OrganizationSelectionCandidate,
      inputCandidate: RecordImportUpdateTargetFactsInput,
    ): Promise<HumanOrganizationRequestResult<RecordImportUpdateTargetFacts>> {
      let session: IdentitySession;
      let selection: OrganizationSelectionCandidate;
      let input: NormalizedInput | undefined;
      try {
        const parsedSession = identitySessionSchema.safeParse(sessionCandidate);
        const parsedSelection = organizationSelectionCandidateSchema.safeParse(selectionCandidate);
        if (
          !parsedSession.success ||
          !parsedSelection.success ||
          parsedSelection.data.applicationRootId === undefined
        )
          return { kind: "unavailable" };
        session = parsedSession.data;
        selection = parsedSelection.data;
        input = normalizeInput(inputCandidate);
      } catch {
        return { kind: "unavailable" };
      }
      if (input === undefined) return { kind: "unavailable" };

      const result = await requests.run(
        session,
        selection,
        async (transaction, scope, issuedAt) => {
          const rows = await transaction.query<SqlResultRow>`
          select vortex_record.read_import_update_targets(
            ${input.recordTypeId}::uuid,
            ${JSON.stringify(input.mappedFieldIds)}::text::jsonb,
            ${JSON.stringify(
              input.targets.map(({ rowNumber, recordIdCandidate }) => ({
                rowNumber,
                recordIdCandidate,
              })),
            )}::text::jsonb
          ) as result
        `;
          if (rows.length !== 1) throw new Error("INVALID_IMPORT_UPDATE_TARGET_RESULT");
          return parseProducerResult(rows[0]?.result, input, session, selection, scope, issuedAt);
        },
      );
      if (result.kind !== "available") return result;
      try {
        const now = clock();
        if (!Number.isFinite(now.valueOf()) || now.valueOf() >= Date.parse(result.value.validUntil))
          return { kind: "temporarily_unavailable" };
      } catch {
        return { kind: "temporarily_unavailable" };
      }
      return result;
    },
  });
};

export type RecordImportUpdateTargetFactsService = ReturnType<
  typeof createRecordImportUpdateTargetFactsService
>;
