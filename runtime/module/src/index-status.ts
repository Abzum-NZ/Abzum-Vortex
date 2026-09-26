import "server-only";

import {
  activeApplicationInstallationEvidenceSchema,
  type ActiveApplicationInstallationEvidence,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

/**
 * Protected read of the live index status of the current active Application
 * installation.
 *
 * It does not accept a caller-authored organisation, Application release or
 * binding set: it first reads the exact active installation selected by the
 * trusted human request context, then asks the Record-owned
 * `vortex_record.read_application_index_status` for that exact installation.
 * That database read performs the Application-management authority check and
 * returns only neutral states, bounded progress counters and, for a readable
 * uniqueness conflict, record references the current caller may read. An
 * unreadable conflict is one indistinguishable refusal.
 */

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fingerprintPattern = /^sha256:[a-f0-9]{64}$/;

export const indexStatusStates = [
  "pending",
  "running",
  "ready",
  "interrupted",
  "conflicting",
] as const;

export type IndexStatusState = (typeof indexStatusStates)[number];

export const indexObservedStates = ["missing", "present", "invalid"] as const;
export type IndexStatusObservedState = (typeof indexObservedStates)[number];

/** Closed neutral failure codes; no physical or record-specific detail. */
export const indexStatusFailureCodes = ["build_interrupted", "uniqueness_conflict"] as const;
export type IndexStatusFailureCode = (typeof indexStatusFailureCodes)[number];

const failureCodeForState = (state: IndexStatusState): IndexStatusFailureCode | null => {
  switch (state) {
    case "interrupted":
      return "build_interrupted";
    case "conflicting":
      return "uniqueness_conflict";
    default:
      return null;
  }
};

export const indexStatusErrorCodes = [
  "INDEX_STATUS_AUTHORITY_REFUSED",
  "INDEX_STATUS_INSTALLATION_UNAVAILABLE",
  "INDEX_STATUS_INCOMPLETE",
  "INDEX_STATUS_READ_FAILED",
] as const;

export type IndexStatusErrorCode = (typeof indexStatusErrorCodes)[number];

export class IndexStatusError extends Error {
  readonly code: IndexStatusErrorCode;

  constructor(code: IndexStatusErrorCode) {
    super(code);
    this.name = "IndexStatusError";
    this.code = code;
  }
}

export type IndexConflictReference = Readonly<{
  recordTypeId: string;
  recordId: string;
}>;

export type IndexConflict =
  | Readonly<{ state: "readable"; records: readonly IndexConflictReference[] }>
  | Readonly<{ state: "unreadable" }>;

export type IndexStatusEntry = Readonly<{
  indexContractId: string;
  storageContractId: string;
  fieldId: string;
  purpose: "uniqueness" | "performance";
  desiredDefinitionFingerprint: string;
  state: IndexStatusState;
  observedState: IndexStatusObservedState;
  recordedObservedState: IndexStatusObservedState | null;
  observedRevision: number | null;
  ready: boolean;
  failureCode: IndexStatusFailureCode | null;
  conflict: IndexConflict | null;
}>;

export type IndexStatusProgress = Readonly<{
  total: number;
  ready: number;
  pending: number;
  running: number;
  interrupted: number;
  conflicting: number;
}>;

export type ApplicationIndexStatus = Readonly<{
  organizationId: string;
  applicationRootId: string;
  applicationReleaseRevision: number;
  indexes: readonly IndexStatusEntry[];
  progress: IndexStatusProgress;
  uniquenessReady: boolean;
  performanceAdvisory: true;
}>;

type ActiveInstallationRow = DatabaseRow & { readonly active_installation: unknown };
type IndexStatusRow = DatabaseRow & { readonly index_status: unknown };

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
): boolean => {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.length === required.length
  );
};

const uuidText = (value: unknown): string | undefined =>
  typeof value === "string" && uuidPattern.test(value) ? value : undefined;

const safeRevision = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;

const safeCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const isState = (value: unknown): value is IndexStatusState =>
  typeof value === "string" && (indexStatusStates as readonly string[]).includes(value);

const isObservedState = (value: unknown): value is IndexStatusObservedState =>
  typeof value === "string" && (indexObservedStates as readonly string[]).includes(value);

const isPurpose = (value: unknown): value is "uniqueness" | "performance" =>
  value === "uniqueness" || value === "performance";

const isFailureCode = (value: unknown): value is IndexStatusFailureCode =>
  typeof value === "string" && (indexStatusFailureCodes as readonly string[]).includes(value);

const undefinedOnInvalidArray = <Value>(
  candidate: unknown,
  parseEntry: (value: unknown) => Value | undefined,
): readonly Value[] | undefined => {
  if (!Array.isArray(candidate)) return undefined;
  const values: Value[] = [];
  for (const value of candidate) {
    const parsed = parseEntry(value);
    if (parsed === undefined) return undefined;
    values.push(parsed);
  }
  return values;
};

const parseConflict = (candidate: unknown): IndexConflict | null | undefined => {
  if (candidate === null) return null;
  if (!isObject(candidate)) return undefined;
  if (candidate.state === "unreadable") {
    return hasExactKeys(candidate, ["state"]) ? { state: "unreadable" } : undefined;
  }
  if (candidate.state !== "readable" || !hasExactKeys(candidate, ["state", "records"]))
    return undefined;
  const records = undefinedOnInvalidArray(
    candidate.records,
    (value): IndexConflictReference | undefined => {
      if (!isObject(value) || !hasExactKeys(value, ["recordTypeId", "recordId"]))
        return undefined;
      const recordTypeId = uuidText(value.recordTypeId);
      const recordId = uuidText(value.recordId);
      if (recordTypeId === undefined || recordId === undefined) return undefined;
      return { recordTypeId, recordId };
    },
  );
  if (records === undefined) return undefined;
  return { state: "readable", records };
};

const parseEntry = (candidate: unknown): IndexStatusEntry | undefined => {
  if (
    !isObject(candidate) ||
    !hasExactKeys(candidate, [
      "indexContractId",
      "storageContractId",
      "fieldId",
      "purpose",
      "desiredDefinitionFingerprint",
      "state",
      "observedState",
      "recordedObservedState",
      "observedRevision",
      "ready",
      "failureCode",
      "conflict",
    ])
  )
    return undefined;

  const indexContractId = uuidText(candidate.indexContractId);
  const storageContractId = uuidText(candidate.storageContractId);
  const fieldId = uuidText(candidate.fieldId);
  const purpose = candidate.purpose;
  const desiredDefinitionFingerprint = candidate.desiredDefinitionFingerprint;
  const state = candidate.state;
  const observedState = candidate.observedState;
  const recordedObservedState = candidate.recordedObservedState;
  const observedRevision = candidate.observedRevision;
  const ready = candidate.ready;
  const failureCode = candidate.failureCode;
  const conflict = parseConflict(candidate.conflict);
  const parsedRecordedObservedState =
    recordedObservedState === null
      ? null
      : isObservedState(recordedObservedState)
        ? recordedObservedState
        : undefined;
  const parsedObservedRevision =
    observedRevision === null ? null : safeRevision(observedRevision);
  const parsedFailureCode =
    failureCode === null ? null : isFailureCode(failureCode) ? failureCode : undefined;
  if (
    indexContractId === undefined ||
    storageContractId === undefined ||
    fieldId === undefined ||
    !isPurpose(purpose) ||
    typeof desiredDefinitionFingerprint !== "string" ||
    !fingerprintPattern.test(desiredDefinitionFingerprint) ||
    !isState(state) ||
    !isObservedState(observedState) ||
    parsedRecordedObservedState === undefined ||
    parsedObservedRevision === undefined ||
    typeof ready !== "boolean" ||
    parsedFailureCode === undefined ||
    conflict === undefined
  )
    return undefined;

  // Ready is only meaningful while the physical index is present and the state
  // agrees; a missing or invalid observation can never read as ready.
  if (ready !== (state === "ready") || (ready && observedState !== "present")) return undefined;
  // Conflict detail exists exactly for the conflicting state; an unreadable one
  // carries nothing else.
  if ((conflict !== null) !== (state === "conflicting")) return undefined;
  if (conflict !== null && conflict.state === "readable" && conflict.records.length === 0)
    return undefined;
  // The neutral failure code is a single closed function of the state.
  if (parsedFailureCode !== failureCodeForState(state)) return undefined;

  return {
    indexContractId,
    storageContractId,
    fieldId,
    purpose,
    desiredDefinitionFingerprint,
    state,
    observedState,
    recordedObservedState: parsedRecordedObservedState,
    observedRevision: parsedObservedRevision,
    ready,
    failureCode: parsedFailureCode,
    conflict,
  };
};

const parseProgress = (candidate: unknown, entryCount: number): IndexStatusProgress | undefined => {
  if (
    !isObject(candidate) ||
    !hasExactKeys(candidate, [
      "total",
      "ready",
      "pending",
      "running",
      "interrupted",
      "conflicting",
    ])
  )
    return undefined;
  // An installation whose fields declare no unique, filterable or sortable
  // value owns no index, so an empty status is a complete one.
  const total = safeCount(candidate.total);
  const ready = safeCount(candidate.ready);
  const pending = safeCount(candidate.pending);
  const running = safeCount(candidate.running);
  const interrupted = safeCount(candidate.interrupted);
  const conflicting = safeCount(candidate.conflicting);
  if (
    total === undefined ||
    ready === undefined ||
    pending === undefined ||
    running === undefined ||
    interrupted === undefined ||
    conflicting === undefined
  )
    return undefined;
  if (total !== entryCount || ready + pending + running + interrupted + conflicting !== total)
    return undefined;
  return { total, ready, pending, running, interrupted, conflicting };
};

const parseStatus = (
  candidate: unknown,
  installation: ActiveApplicationInstallationEvidence,
): ApplicationIndexStatus | undefined => {
  if (
    !isObject(candidate) ||
    !hasExactKeys(candidate, [
      "organizationId",
      "applicationRootId",
      "applicationReleaseRevision",
      "indexes",
      "progress",
      "uniquenessReady",
      "performanceAdvisory",
    ])
  )
    return undefined;

  const organizationId = uuidText(candidate.organizationId);
  const applicationRootId = uuidText(candidate.applicationRootId);
  const applicationReleaseRevision = safeRevision(candidate.applicationReleaseRevision);
  const indexes = undefinedOnInvalidArray(candidate.indexes, parseEntry);
  const uniquenessReady = candidate.uniquenessReady;
  if (
    organizationId === undefined ||
    applicationRootId === undefined ||
    applicationReleaseRevision === undefined ||
    indexes === undefined ||
    typeof uniquenessReady !== "boolean" ||
    candidate.performanceAdvisory !== true
  )
    return undefined;

  // The snapshot can only be trusted for the exact installation it names.
  if (
    organizationId.toLowerCase() !== installation.organizationId.toLowerCase() ||
    applicationRootId.toLowerCase() !== installation.applicationRootId.toLowerCase() ||
    applicationReleaseRevision !== installation.applicationReleaseRevision
  )
    return undefined;

  const progress = parseProgress(candidate.progress, indexes.length);
  if (progress === undefined) return undefined;

  const requiredReady = indexes.every((entry) => entry.purpose !== "uniqueness" || entry.ready);
  if (uniquenessReady !== requiredReady) return undefined;

  return {
    organizationId,
    applicationRootId,
    applicationReleaseRevision,
    indexes,
    progress,
    uniquenessReady,
    performanceAdvisory: true,
  };
};

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const mapFailure = (error: unknown): IndexStatusError => {
  if (error instanceof IndexStatusError) return error;
  switch (databaseCode(error)) {
    case "42501":
      return new IndexStatusError("INDEX_STATUS_AUTHORITY_REFUSED");
    case "P0002":
      return new IndexStatusError("INDEX_STATUS_INSTALLATION_UNAVAILABLE");
    case "22023":
    case "23514":
    case "55000":
      return new IndexStatusError("INDEX_STATUS_INCOMPLETE");
    default:
      return new IndexStatusError("INDEX_STATUS_READ_FAILED");
  }
};

export interface ApplicationIndexStatusRepository {
  readCurrent(): Promise<ApplicationIndexStatus>;
}

/** Reads only the index status of the active installation selected by trusted human application context. */
export const createApplicationIndexStatusRepository = (
  transaction: RequestDatabaseTransaction,
): ApplicationIndexStatusRepository =>
  Object.freeze({
    async readCurrent() {
      try {
        const installationRows = await transaction.query<ActiveInstallationRow>`
          select vortex_module.read_current_active_installation() as active_installation
        `;
        if (
          installationRows.length !== 1 ||
          installationRows[0] === undefined ||
          installationRows[0].active_installation === null
        )
          throw new IndexStatusError("INDEX_STATUS_INSTALLATION_UNAVAILABLE");
        const installation = activeApplicationInstallationEvidenceSchema.safeParse(
          installationRows[0].active_installation,
        );
        if (!installation.success) throw new IndexStatusError("INDEX_STATUS_INCOMPLETE");

        const expectedModuleBindings = installation.data.moduleBindings.map((binding) => ({
          moduleRootId: binding.moduleRootId,
          bindingRevision: binding.bindingRevision,
        }));

        const statusRows = await transaction.query<IndexStatusRow>`
          select vortex_record.read_application_index_status(
            ${installation.data.organizationId}::uuid,
            ${installation.data.applicationRootId}::uuid,
            ${installation.data.applicationReleaseRevision}::bigint,
            ${JSON.stringify(expectedModuleBindings)}::text::jsonb
          ) as index_status
        `;
        if (statusRows.length !== 1 || statusRows[0] === undefined)
          throw new IndexStatusError("INDEX_STATUS_READ_FAILED");

        const status = parseStatus(statusRows[0].index_status, installation.data);
        if (status === undefined) throw new IndexStatusError("INDEX_STATUS_INCOMPLETE");
        return status;
      } catch (error) {
        throw mapFailure(error);
      }
    },
  });
