import "server-only";

import { fieldIdSchema, fingerprintSchema, storageContractIdSchema } from "@vortex/contracts";
import type { DatabaseRow, RuntimeDatabaseTransaction } from "@vortex/db";

/**
 * Bounded operational runner for the #612 concurrent field-index build.
 *
 * It mirrors `@vortex/workflow`'s deadline dispatcher: it never derives an
 * identity, statement or authority itself. Each iteration
 *
 * 1. opens one short worker transaction and calls
 *    `vortex_record.claim_record_index_build`, which leases one non-present
 *    catalogue row and returns the exact statements it needs;
 * 2. runs each returned statement as a standalone statement outside any
 *    transaction block, because PostgreSQL refuses `CREATE INDEX CONCURRENTLY`
 *    and `DROP INDEX CONCURRENTLY` inside one;
 * 3. opens one more short worker transaction and calls
 *    `vortex_record.record_index_build_result`, which re-observes the physical
 *    definition and records readiness.
 *
 * Nothing here supplies SQL or a physical name: both come back from the
 * Record-owned catalogue, and physical statements are only ever produced for a
 * worker that already owns the record data tables. `runWorkerTransaction` and
 * `runStandaloneStatement` must both be bound to that operational worker login;
 * neither may run on a human request connection.
 */

export const indexBuildRunnerLimits = Object.freeze({
  /** Index builds attempted by one run when the caller names no limit. */
  defaultBatchLimit: 25,
  /** Absolute ceiling on index builds attempted by one run. */
  maximumBatchLimit: 100,
  /** Build lease applied when the caller names no lease. */
  defaultLeaseSeconds: 300,
  /** Absolute ceiling on a build lease, in seconds. */
  maximumLeaseSeconds: 86_400,
});

export const indexBuildRunnerErrorCodes = [
  "INVALID_INDEX_BUILD_RUNNER_INPUT",
  "INDEX_BUILD_RUNNER_DEPENDENCIES_REQUIRED",
  "INDEX_BUILD_RESULT_INVALID",
] as const;

export type IndexBuildRunnerErrorCode = (typeof indexBuildRunnerErrorCodes)[number];

export class IndexBuildRunnerError extends Error {
  readonly code: IndexBuildRunnerErrorCode;

  constructor(code: IndexBuildRunnerErrorCode) {
    super(code);
    this.name = "IndexBuildRunnerError";
    this.code = code;
  }
}

/**
 * Opens one fresh transaction on the operational index-build worker login and
 * commits it when `operation` resolves (rolls back when it throws). Claim and
 * result calls must each be a new transaction on that login.
 */
export type IndexBuildWorkerTransactionRunner = <Result>(
  operation: (transaction: RuntimeDatabaseTransaction) => Promise<Result>,
) => Promise<Result>;

/**
 * Executes one derived DDL statement as a standalone statement outside any
 * transaction block. It must be bound to a connection that owns the record data
 * tables, because PostgreSQL only builds an index concurrently for the table
 * owner.
 */
export type IndexBuildStandaloneStatementRunner = (statement: string) => Promise<void>;

export type IndexBuildRunInput = Readonly<{
  /** Index builds attempted by this run, within the batch ceiling. */
  batchLimit?: number;
  /** Seconds one claimed build is leased before it is treated as interrupted. */
  leaseSeconds?: number;
}>;

export const indexBuildRefusalReasonCodes = [
  "command_invalid",
  "index_unknown",
  "storage_contract_unavailable",
  "field_unavailable",
  "index_definition_drifted",
  "uniqueness_enforcement_present",
  "desired_definition_changed",
  "definition_mismatch",
  "lease_not_owned",
] as const;

export type IndexBuildRefusalReasonCode = (typeof indexBuildRefusalReasonCodes)[number];

export type IndexBuildItemResult = Readonly<{
  indexContractId: string;
  storageContractId: string;
  fieldId: string;
  purpose: "uniqueness" | "performance";
  desiredDefinitionFingerprint: string;
  outcome: "present" | "missing" | "invalid" | "refused";
  reasonCode?: IndexBuildRefusalReasonCode;
}>;

export type IndexBuildStop =
  | Readonly<{ stage: "claim"; outcome: "repeated_claim" }>
  | Readonly<{ stage: "claim"; outcome: "refused"; reasonCode: string }>
  | Readonly<{ stage: "build"; outcome: "failed" }>
  | Readonly<{ stage: "record"; outcome: "not_ready" }>
  | Readonly<{ stage: "record"; outcome: "refused"; reasonCode: string }>;

export type IndexBuildRunResult =
  | Readonly<{ status: "idle"; items: readonly IndexBuildItemResult[] }>
  | Readonly<{ status: "drained"; items: readonly IndexBuildItemResult[] }>
  | Readonly<{ status: "limit_reached"; items: readonly IndexBuildItemResult[] }>
  | Readonly<{ status: "stopped"; stop: IndexBuildStop; items: readonly IndexBuildItemResult[] }>;

export type IndexBuildRunnerDependencies = Readonly<{
  runWorkerTransaction: IndexBuildWorkerTransactionRunner;
  runStandaloneStatement: IndexBuildStandaloneStatementRunner;
}>;

export interface IndexBuildRunner {
  run(inputCandidate?: unknown): Promise<IndexBuildRunResult>;
}

type ClaimRow = DatabaseRow & { readonly result: unknown };

type IndexBuildJob = Readonly<{
  indexContractId: string;
  storageContractId: string;
  fieldId: string;
  purpose: "uniqueness" | "performance";
  desiredDefinitionFingerprint: string;
  statements: readonly string[];
}>;

type ParsedClaim =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "refused"; reasonCode: string }>
  | Readonly<{ kind: "claimed"; job: IndexBuildJob }>;

type ParsedRecord =
  | Readonly<{ kind: "recorded"; observedState: "present" | "missing" | "invalid" }>
  | Readonly<{ kind: "refused"; reasonCode: string }>;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
};

const invalidInput = (): IndexBuildRunnerError =>
  new IndexBuildRunnerError("INVALID_INDEX_BUILD_RUNNER_INPUT");

const invalidResult = (): IndexBuildRunnerError =>
  new IndexBuildRunnerError("INDEX_BUILD_RESULT_INVALID");

const parseBoundedInteger = (
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : undefined;

const isPurpose = (value: unknown): value is "uniqueness" | "performance" =>
  value === "uniqueness" || value === "performance";

const isObservedState = (value: unknown): value is "present" | "missing" | "invalid" =>
  value === "present" || value === "missing" || value === "invalid";

const uuidText = (value: unknown): string | undefined => {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
    return undefined;
  return value;
};

/**
 * Accepts only the single-statement DDL the catalogue derives: a concurrent
 * create or cleanup against `record_data`. The runner never assembles SQL, so
 * this bounds a compromised or drifted catalogue return to one known shape.
 */
const parseStatements = (candidate: unknown): readonly string[] | undefined => {
  if (!Array.isArray(candidate) || candidate.length < 1 || candidate.length > 3) return undefined;
  const statements: string[] = [];
  for (const entry of candidate) {
    if (typeof entry !== "string" || entry.length < 1 || entry.length > 2000) return undefined;
    if (entry.includes(";") || entry.includes("--") || entry.includes("/*")) return undefined;
    if (
      !/^(?:create (?:unique )?index concurrently|drop index concurrently if exists) /.test(entry)
    )
      return undefined;
    if (!entry.includes("record_data.")) return undefined;
    statements.push(entry);
  }
  return statements;
};

const parseClaim = (candidate: unknown): ParsedClaim => {
  if (!isObject(candidate)) throw invalidResult();
  if (candidate.outcome === "none" && hasExactKeys(candidate, ["outcome"]))
    return { kind: "none" };
  if (
    candidate.outcome === "refused" &&
    hasExactKeys(candidate, ["outcome", "reasonCode"]) &&
    typeof candidate.reasonCode === "string" &&
    candidate.reasonCode.length > 0 &&
    candidate.reasonCode.length <= 64
  )
    return { kind: "refused", reasonCode: candidate.reasonCode };
  if (
    candidate.outcome !== "claimed" ||
    !hasExactKeys(candidate, [
      "outcome",
      "indexContractId",
      "storageContractId",
      "fieldId",
      "purpose",
      "desiredDefinitionFingerprint",
      "statements",
    ])
  )
    throw invalidResult();

  const indexContractId = uuidText(candidate.indexContractId);
  const storageContractId = storageContractIdSchema.safeParse(candidate.storageContractId);
  const fieldId = fieldIdSchema.safeParse(candidate.fieldId);
  const fingerprint = fingerprintSchema.safeParse(candidate.desiredDefinitionFingerprint);
  const statements = parseStatements(candidate.statements);
  const purpose = candidate.purpose;
  if (
    indexContractId === undefined ||
    !storageContractId.success ||
    !fieldId.success ||
    !isPurpose(purpose) ||
    !fingerprint.success ||
    statements === undefined
  )
    throw invalidResult();

  return {
    kind: "claimed",
    job: {
      indexContractId,
      storageContractId: storageContractId.data,
      fieldId: fieldId.data,
      purpose,
      desiredDefinitionFingerprint: fingerprint.data,
      statements,
    },
  };
};

const parseRecord = (candidate: unknown): ParsedRecord => {
  if (!isObject(candidate)) throw invalidResult();
  if (
    candidate.outcome === "refused" &&
    hasExactKeys(candidate, ["outcome", "reasonCode"]) &&
    typeof candidate.reasonCode === "string" &&
    candidate.reasonCode.length > 0 &&
    candidate.reasonCode.length <= 64
  )
    return { kind: "refused", reasonCode: candidate.reasonCode };
  const outcome = candidate.outcome;
  if (
    !isObservedState(outcome) ||
    !hasExactKeys(candidate, [
      "outcome",
      "indexContractId",
      "storageContractId",
      "fieldId",
      "purpose",
      "desiredDefinitionFingerprint",
      "observedState",
    ]) ||
    candidate.observedState !== outcome
  )
    throw invalidResult();
  return { kind: "recorded", observedState: outcome };
};

type ValidatedRunInput = Readonly<{ batchLimit: number; leaseSeconds: number }>;

const validateRunInput = (candidate: unknown): ValidatedRunInput => {
  if (candidate === undefined)
    return {
      batchLimit: indexBuildRunnerLimits.defaultBatchLimit,
      leaseSeconds: indexBuildRunnerLimits.defaultLeaseSeconds,
    };
  if (!isObject(candidate) || !hasExactKeys(candidate, [], ["batchLimit", "leaseSeconds"]))
    throw invalidInput();
  const batchLimit =
    candidate.batchLimit === undefined
      ? indexBuildRunnerLimits.defaultBatchLimit
      : parseBoundedInteger(candidate.batchLimit, 1, indexBuildRunnerLimits.maximumBatchLimit);
  const leaseSeconds =
    candidate.leaseSeconds === undefined
      ? indexBuildRunnerLimits.defaultLeaseSeconds
      : parseBoundedInteger(candidate.leaseSeconds, 1, indexBuildRunnerLimits.maximumLeaseSeconds);
  if (batchLimit === undefined || leaseSeconds === undefined) throw invalidInput();
  return { batchLimit, leaseSeconds };
};

const jobIdentity = (job: IndexBuildJob): Omit<IndexBuildItemResult, "outcome"> => ({
  indexContractId: job.indexContractId,
  storageContractId: job.storageContractId,
  fieldId: job.fieldId,
  purpose: job.purpose,
  desiredDefinitionFingerprint: job.desiredDefinitionFingerprint,
});

const claimOnce = async (
  dependencies: IndexBuildRunnerDependencies,
  leaseSeconds: number,
): Promise<ParsedClaim> =>
  dependencies.runWorkerTransaction(async (transaction) => {
    const rows = await transaction.query<ClaimRow>`
      select vortex_record.claim_record_index_build(${leaseSeconds}::integer) as result
    `;
    const row = rows[0];
    if (rows.length !== 1 || row === undefined) throw invalidResult();
    return parseClaim(row.result);
  });

const recordOnce = async (
  dependencies: IndexBuildRunnerDependencies,
  job: IndexBuildJob,
): Promise<ParsedRecord> =>
  dependencies.runWorkerTransaction(async (transaction) => {
    const rows = await transaction.query<ClaimRow>`
      select vortex_record.record_index_build_result(
        ${job.storageContractId}::uuid,
        ${job.fieldId}::uuid,
        ${job.desiredDefinitionFingerprint}::text
      ) as result
    `;
    const row = rows[0];
    if (rows.length !== 1 || row === undefined) throw invalidResult();
    return parseRecord(row.result);
  });

const runBuild = async (
  dependencies: IndexBuildRunnerDependencies,
  input: ValidatedRunInput,
): Promise<IndexBuildRunResult> => {
  const items: IndexBuildItemResult[] = [];
  const claimedIdentities = new Set<string>();

  while (items.length < input.batchLimit) {
    const claim = await claimOnce(dependencies, input.leaseSeconds);
    if (claim.kind === "none")
      return items.length === 0 ? { status: "idle", items } : { status: "drained", items };
    if (claim.kind === "refused")
      return {
        status: "stopped",
        stop: { stage: "claim", outcome: "refused", reasonCode: claim.reasonCode },
        items,
      };

    const job = claim.job;
    const identity = `${job.storageContractId}:${job.fieldId}`;
    // A row that is still non-present after its own build would be claimed
    // again; that repeats, so the run stops rather than spinning on it.
    if (claimedIdentities.has(identity))
      return { status: "stopped", stop: { stage: "claim", outcome: "repeated_claim" }, items };
    claimedIdentities.add(identity);

    let buildFailed = false;
    for (const statement of job.statements) {
      try {
        await dependencies.runStandaloneStatement(statement);
      } catch {
        buildFailed = true;
        break;
      }
    }

    const recorded = await recordOnce(dependencies, job);
    items.push(
      recorded.kind === "refused"
        ? { ...jobIdentity(job), outcome: "refused", reasonCode: recorded.reasonCode }
        : { ...jobIdentity(job), outcome: recorded.observedState },
    );

    if (buildFailed)
      return { status: "stopped", stop: { stage: "build", outcome: "failed" }, items };
    if (recorded.kind === "refused")
      return {
        status: "stopped",
        stop: { stage: "record", outcome: "refused", reasonCode: recorded.reasonCode },
        items,
      };
    // Only a physically present index is progress; a missing or invalid result
    // leaves the row for a later retry.
    if (recorded.observedState !== "present")
      return { status: "stopped", stop: { stage: "record", outcome: "not_ready" }, items };
  }

  return { status: "limit_reached", items };
};

/**
 * Creates the bounded index-build runner over the operational worker
 * dependencies. It never derives identities, statements or authority itself.
 */
export const createIndexBuildRunner = (
  dependencies: IndexBuildRunnerDependencies,
): IndexBuildRunner => {
  if (
    !isObject(dependencies) ||
    typeof dependencies.runWorkerTransaction !== "function" ||
    typeof dependencies.runStandaloneStatement !== "function"
  )
    throw new IndexBuildRunnerError("INDEX_BUILD_RUNNER_DEPENDENCIES_REQUIRED");
  return Object.freeze({
    async run(inputCandidate?: unknown): Promise<IndexBuildRunResult> {
      return runBuild(dependencies, validateRunInput(inputCandidate));
    },
  });
};

/** Runs one bounded batch of concurrent field-index builds. */
export const runIndexBuild = async (
  dependencies: IndexBuildRunnerDependencies,
  inputCandidate?: unknown,
): Promise<IndexBuildRunResult> =>
  createIndexBuildRunner(dependencies).run(inputCandidate);
