import "server-only";

import {
  applicationRootIdSchema,
  fingerprintSchema,
  organizationIdSchema,
  revisionSchema,
  stableDefinitionReleaseVersionSchema,
  timestampSchema,
  type ApplicationRootId,
  type OrganizationId,
  type SemanticVersion,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  kestraFlowCompilerEnvironments,
  type KestraFlowCandidate,
  type KestraFlowCompilerEnvironment,
  type KestraFlowIdentity,
} from "./kestra-compiler";

/**
 * #947: storage-bound repository for inactive workflow flow registrations.
 *
 * A part A candidate is compiled by `compileKestraFlow` from one exact published
 * WorkflowDefinition and its installation identity. This repository persists
 * that candidate through the protected `register_workflow_flow_candidate`
 * function, which derives nothing from the candidate's diagnostic labels: the
 * namespace must equal the one derived from the permanent identity, the flow id
 * must name the exact release, and the candidate must be inactive.
 *
 * It runs inside an already established private flow-preparation transaction on
 * the runtime connection, never a human request transaction, and it never calls,
 * runs or deploys Kestra. Registration is duplicate-safe: repeating one exact
 * identity and candidate converges on the stored row, while a different
 * candidate for the same identity is refused rather than overwritten.
 */

export const kestraFlowRegistrationStatuses = ["inactive"] as const;

export type KestraFlowRegistrationStatus = (typeof kestraFlowRegistrationStatuses)[number];

export const kestraFlowRegistrationRefusalReasons = ["candidate_changed"] as const;

export type KestraFlowRegistrationRefusalReason =
  (typeof kestraFlowRegistrationRefusalReasons)[number];

/** One persisted inactive provider mapping for one exact installation and release. */
export type KestraFlowRegistration = Readonly<{
  environment: KestraFlowCompilerEnvironment;
  organizationId: OrganizationId;
  applicationRootId: ApplicationRootId;
  applicationVersion: SemanticVersion;
  installationRevision: number;
  workflowRevision: number;
  namespace: string;
  flowId: string;
  candidateFingerprint: string;
  status: KestraFlowRegistrationStatus;
  registeredAt: string;
}>;

export type KestraFlowRegistrationResult =
  | Readonly<{ outcome: "registered"; registration: KestraFlowRegistration }>
  | Readonly<{ outcome: "existing"; registration: KestraFlowRegistration }>
  | Readonly<{ outcome: "refused"; reasonCode: KestraFlowRegistrationRefusalReason }>;

/** The part A candidate together with the exact identity it was compiled from. */
export type KestraFlowRegistrationCommand = Readonly<{
  identity: KestraFlowIdentity;
  flow: KestraFlowCandidate;
}>;

export const kestraFlowRegistrationErrorCodes = [
  "INVALID_FLOW_REGISTRATION_INPUT",
  "INVALID_FLOW_REGISTRATION_STORAGE_RESULT",
  "FLOW_REGISTRATION_FAILED",
] as const;

export type KestraFlowRegistrationErrorCode = (typeof kestraFlowRegistrationErrorCodes)[number];

export class KestraFlowRegistrationError extends Error {
  readonly code: KestraFlowRegistrationErrorCode;

  constructor(code: KestraFlowRegistrationErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "KestraFlowRegistrationError";
    this.code = code;
  }
}

type RegistrationRow = DatabaseRow & { readonly outcome: unknown; readonly result: unknown };

const identityKeys = [
  "environment",
  "organizationId",
  "applicationRootId",
  "applicationVersion",
  "installationRevision",
  "workflowRevision",
] as const;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean => Object.keys(value).every((key) => allowed.includes(key));

const invalidInput = (): KestraFlowRegistrationError =>
  new KestraFlowRegistrationError("INVALID_FLOW_REGISTRATION_INPUT");

const invalidStorageResult = (cause?: unknown): KestraFlowRegistrationError =>
  new KestraFlowRegistrationError("INVALID_FLOW_REGISTRATION_STORAGE_RESULT", { cause });

/**
 * Validates exactly the six permanent identity fields and canonicalises the
 * UUIDs to lower case, so one identity always shortens to one namespace.
 */
const parseIdentity = (candidate: unknown): KestraFlowIdentity | undefined => {
  if (!isObject(candidate) || !hasOnlyKeys(candidate, identityKeys)) return undefined;
  if (
    typeof candidate.environment !== "string" ||
    !(kestraFlowCompilerEnvironments as readonly string[]).includes(candidate.environment)
  )
    return undefined;

  const organizationId = organizationIdSchema.safeParse(candidate.organizationId);
  const applicationRootId = applicationRootIdSchema.safeParse(candidate.applicationRootId);
  const applicationVersion = stableDefinitionReleaseVersionSchema.safeParse(
    candidate.applicationVersion,
  );
  const installationRevision = revisionSchema.safeParse(candidate.installationRevision);
  const workflowRevision = revisionSchema.safeParse(candidate.workflowRevision);
  if (
    !organizationId.success ||
    !applicationRootId.success ||
    !applicationVersion.success ||
    !installationRevision.success ||
    !workflowRevision.success
  )
    return undefined;

  return Object.freeze({
    environment: candidate.environment as KestraFlowCompilerEnvironment,
    organizationId: organizationId.data.toLowerCase() as OrganizationId,
    applicationRootId: applicationRootId.data.toLowerCase() as ApplicationRootId,
    applicationVersion: applicationVersion.data,
    installationRevision: installationRevision.data,
    workflowRevision: workflowRevision.data,
  });
};

/**
 * Parses the command at the storage boundary. The candidate's active flag and
 * revision are rechecked against the identity before any statement runs; the
 * database revalidates them and the generated identity again under its own
 * transaction, so a caller cannot store a runnable or mismatched candidate.
 */
const parseCommand = (candidate: unknown): KestraFlowRegistrationCommand => {
  if (!isObject(candidate) || !hasOnlyKeys(candidate, ["identity", "flow"])) throw invalidInput();
  const identity = parseIdentity(candidate.identity);
  if (identity === undefined || !isObject(candidate.flow)) throw invalidInput();

  const flow = candidate.flow;
  if (flow.active !== false) throw invalidInput();
  if (
    typeof flow.workflowRevision !== "number" ||
    flow.workflowRevision !== identity.workflowRevision ||
    typeof flow.namespace !== "string" ||
    typeof flow.id !== "string" ||
    !isObject(flow.trigger)
  )
    throw invalidInput();

  return Object.freeze({ identity, flow: flow as unknown as KestraFlowCandidate });
};

const parseRegistration = (value: unknown): KestraFlowRegistration => {
  if (!isObject(value)) throw invalidStorageResult();
  if (
    typeof value.environment !== "string" ||
    !(kestraFlowCompilerEnvironments as readonly string[]).includes(value.environment)
  )
    throw invalidStorageResult();

  const organizationId = organizationIdSchema.safeParse(value.organizationId);
  const applicationRootId = applicationRootIdSchema.safeParse(value.applicationRootId);
  const applicationVersion = stableDefinitionReleaseVersionSchema.safeParse(
    value.applicationVersion,
  );
  const installationRevision = revisionSchema.safeParse(value.installationRevision);
  const workflowRevision = revisionSchema.safeParse(value.workflowRevision);
  const candidateFingerprint = fingerprintSchema.safeParse(value.candidateFingerprint);
  const registeredAt = timestampSchema.safeParse(value.registeredAt);
  if (
    !organizationId.success ||
    !applicationRootId.success ||
    !applicationVersion.success ||
    !installationRevision.success ||
    !workflowRevision.success ||
    typeof value.namespace !== "string" ||
    typeof value.flowId !== "string" ||
    !candidateFingerprint.success ||
    !registeredAt.success ||
    value.status !== "inactive"
  )
    throw invalidStorageResult();

  return Object.freeze({
    environment: value.environment as KestraFlowCompilerEnvironment,
    organizationId: organizationId.data,
    applicationRootId: applicationRootId.data,
    applicationVersion: applicationVersion.data,
    installationRevision: installationRevision.data,
    workflowRevision: workflowRevision.data,
    namespace: value.namespace,
    flowId: value.flowId,
    candidateFingerprint: candidateFingerprint.data,
    status: "inactive",
    registeredAt: registeredAt.data,
  });
};

const parseResult = (rows: readonly RegistrationRow[]): KestraFlowRegistrationResult => {
  if (rows.length !== 1 || rows[0] === undefined) throw invalidStorageResult();
  const row = rows[0];
  if (row.outcome === "registered" || row.outcome === "existing")
    return Object.freeze({ outcome: row.outcome, registration: parseRegistration(row.result) });
  if (row.outcome === "refused") {
    if (!isObject(row.result)) throw invalidStorageResult();
    const reasonCode = row.result.reasonCode;
    if (
      typeof reasonCode !== "string" ||
      !(kestraFlowRegistrationRefusalReasons as readonly string[]).includes(reasonCode)
    )
      throw invalidStorageResult();
    return Object.freeze({
      outcome: "refused",
      reasonCode: reasonCode as KestraFlowRegistrationRefusalReason,
    });
  }
  throw invalidStorageResult();
};

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const mapStorageFailure = (error: unknown): KestraFlowRegistrationError => {
  if (error instanceof KestraFlowRegistrationError) return error;
  switch (databaseCode(error)) {
    // The database revalidates every input the repository already parsed, so a
    // refusal there is still an invalid command, never a partial registration.
    case "22023":
    case "23502":
    case "23503":
      return new KestraFlowRegistrationError("INVALID_FLOW_REGISTRATION_INPUT", { cause: error });
    default:
      return new KestraFlowRegistrationError("FLOW_REGISTRATION_FAILED", { cause: error });
  }
};

/**
 * Persists one part A candidate through the protected registration function in
 * the caller's private flow-preparation transaction. It returns the stored
 * inactive mapping, reports an exact retry as `existing`, and refuses a changed
 * candidate for an existing identity. It never enables, calls or deploys a flow.
 */
export const registerKestraFlowCandidate = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: unknown,
): Promise<KestraFlowRegistrationResult> => {
  const command = parseCommand(commandCandidate);
  try {
    const rows = await transaction.query<RegistrationRow>`
      select outcome, result
      from vortex_workflow.register_workflow_flow_candidate(
        ${command.identity.environment}::text,
        ${command.identity.organizationId}::uuid,
        ${command.identity.applicationRootId}::uuid,
        ${command.identity.applicationVersion}::text,
        ${command.identity.installationRevision}::bigint,
        ${command.identity.workflowRevision}::bigint,
        ${JSON.stringify(command.flow)}::text::jsonb
      )
    `;
    return parseResult(rows);
  } catch (error) {
    throw mapStorageFailure(error);
  }
};
