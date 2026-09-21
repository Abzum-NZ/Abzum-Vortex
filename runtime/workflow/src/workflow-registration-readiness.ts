import "server-only";

import {
  applicationRootIdSchema,
  organizationIdSchema,
  registeredWorkflowEvidenceSchema,
  revisionSchema,
  workflowIdSchema,
  workflowRegistrationReadinessReasonCodeSchema,
  workflowRegistrationReadinessResultSchema,
  type ApplicationRootId,
  type OrganizationId,
  type RegisteredWorkflowEvidence,
  type Revision,
  type WorkflowId,
  type WorkflowRegistrationReadinessReasonCode,
  type WorkflowRegistrationReadinessResult,
} from "@vortex/contracts";
import type { RequestDatabaseTransaction } from "@vortex/db";

/**
 * Authoritative input contract for checking workflow registration readiness.
 */
export type WorkflowRegistrationReadinessInput = Readonly<{
  workflowId: WorkflowId;
  expectedRevision: Revision;
  organizationId: OrganizationId;
  applicationRootId: ApplicationRootId | null;
  archiveDestination?: string | null;
  expectedFingerprint?: string | null;
}>;

/**
 * Raw row shape returned by `vortex_workflow.check_workflow_registration_readiness`.
 */
type CheckReadinessRow = Readonly<{
  result: unknown;
}>;

/**
 * Raw row shape returned by `vortex_workflow.read_registered_workflow_evidence`.
 */
type EvidenceRow = Readonly<{
  workflow_id: unknown;
  workflow_revision: unknown;
  organization_id: unknown;
  authorized_application_ids: unknown;
  state: unknown;
  definition_fingerprint: unknown;
  verified_flow_fingerprint: unknown;
  supported_destinations: unknown;
}>;

/**
 * Checks workflow registration readiness for an archive workflow dependency
 * against authoritative workflow storage.
 *
 * Fails closed on:
 *   - Missing, nil, or malformed UUIDs
 *   - Organization mismatch (workflow belongs to a different organization)
 *   - Scope mismatch (missing application root or workflow not authorized for application)
 *   - Stale or non-existent revision
 *   - Pending ('registered', 'prepared', 'verified'), inactive, or superseded states
 *   - Stale or unverified fingerprints
 *   - Archive destination mismatch
 *   - Any database error
 */
export async function checkWorkflowRegistrationReadiness(
  transaction: RequestDatabaseTransaction,
  input: WorkflowRegistrationReadinessInput,
): Promise<WorkflowRegistrationReadinessResult> {
  // Validate input parameters defensively before invoking the database.
  const workflowId = workflowIdSchema.parse(input.workflowId);
  const expectedRevision = revisionSchema.parse(input.expectedRevision);
  const organizationId = organizationIdSchema.parse(input.organizationId);
  const applicationRootId =
    input.applicationRootId !== null && input.applicationRootId !== undefined
      ? applicationRootIdSchema.parse(input.applicationRootId)
      : null;

  const archiveDestination =
    input.archiveDestination !== undefined && input.archiveDestination !== null
      ? String(input.archiveDestination).trim()
      : null;

  const expectedFingerprint =
    input.expectedFingerprint !== undefined && input.expectedFingerprint !== null
      ? String(input.expectedFingerprint).trim()
      : null;

  const rows = await transaction.query<CheckReadinessRow>`
    select vortex_workflow.check_workflow_registration_readiness(
      ${workflowId},
      ${expectedRevision},
      ${organizationId},
      ${applicationRootId},
      ${archiveDestination},
      ${expectedFingerprint}
    ) as result
  `;

  if (!rows || rows.length === 0 || !rows[0]) {
    throw new Error("Workflow registration readiness: database returned empty result");
  }

  const rawResult = rows[0].result;
  const parsed = workflowRegistrationReadinessResultSchema.safeParse(rawResult);

  if (!parsed.success) {
    throw new Error(
      `Workflow registration readiness: malformed check response: ${parsed.error.message}`,
    );
  }

  return parsed.data;
}

/**
 * Reads active registered workflow evidence for an organization (and optional application),
 * returning validated `RegisteredWorkflowEvidence` items suitable for feeding
 * `lifecycleReadinessEvidenceSchema`.
 */
export async function readRegisteredWorkflowEvidence(
  transaction: RequestDatabaseTransaction,
  input: {
    organizationId: OrganizationId;
    applicationRootId?: ApplicationRootId | null;
  },
): Promise<readonly RegisteredWorkflowEvidence[]> {
  const organizationId = organizationIdSchema.parse(input.organizationId);
  const applicationRootId =
    input.applicationRootId !== null && input.applicationRootId !== undefined
      ? applicationRootIdSchema.parse(input.applicationRootId)
      : null;

  const rows = await transaction.query<EvidenceRow>`
    select workflow_id,
           workflow_revision,
           organization_id,
           authorized_application_ids,
           state,
           definition_fingerprint,
           verified_flow_fingerprint,
           supported_destinations
    from vortex_workflow.read_registered_workflow_evidence(
      ${organizationId},
      ${applicationRootId}
    )
  `;

  const seenWorkflowIds = new Set<string>();
  const evidenceList: RegisteredWorkflowEvidence[] = [];

  for (const row of rows) {
    const rawWorkflowId = workflowIdSchema.parse(row.workflow_id);
    const canonicalId = rawWorkflowId.toLowerCase();

    if (seenWorkflowIds.has(canonicalId)) {
      throw new Error(
        `Workflow registration readiness: duplicate active workflow identity in result: ${rawWorkflowId}`,
      );
    }
    seenWorkflowIds.add(canonicalId);

    const rawRevision = row.workflow_revision;
    const numericRevision =
      typeof rawRevision === "bigint"
        ? Number(rawRevision)
        : typeof rawRevision === "string" || typeof rawRevision === "number"
          ? Number(rawRevision)
          : Number.NaN;

    if (
      !Number.isSafeInteger(numericRevision) ||
      numericRevision < 1 ||
      numericRevision > 9007199254740991
    ) {
      throw new Error(
        `Workflow registration readiness: invalid workflow revision for ${rawWorkflowId}: ${String(rawRevision)}`,
      );
    }

    const rawOrgId = organizationIdSchema.parse(row.organization_id);
    if (rawOrgId !== organizationId) {
      throw new Error(
        `Workflow registration readiness: organization mismatch for ${rawWorkflowId}`,
      );
    }

    const state = row.state;
    if (state !== "active") {
      throw new Error(
        `Workflow registration readiness: non-active workflow in evidence query for ${rawWorkflowId}: ${String(state)}`,
      );
    }

    // Parse authorized applications
    const rawAppIds = Array.isArray(row.authorized_application_ids)
      ? row.authorized_application_ids
      : [];
    const authorizedApplicationIds: ApplicationRootId[] = rawAppIds.map((id) =>
      applicationRootIdSchema.parse(id),
    );

    const parsedItem = registeredWorkflowEvidenceSchema.parse({
      workflowId: rawWorkflowId,
      workflowRevision: numericRevision,
      organizationId: rawOrgId,
      authorizedApplicationIds,
      state: "active",
    });

    evidenceList.push(parsedItem);
  }

  return Object.freeze(evidenceList);
}

/**
 * Pure evaluation helper: checks readiness of an archive workflow policy
 * against in-memory registered workflow evidence items and registration metadata.
 *
 * Explicitly rejects:
 *   - Pending/inactive/superseded workflow states
 *   - Organization mismatch
 *   - Application authorization mismatch
 *   - Stale revisions
 *   - Stale fingerprints
 *   - Destination mismatches
 */
export function evaluateWorkflowRegistrationReadinessLocally(
  check: WorkflowRegistrationReadinessInput,
  evidence: readonly RegisteredWorkflowEvidence[],
  metadata?: Readonly<{
    supportedDestinations?: readonly string[];
    verifiedFlowFingerprint?: string;
  }>,
): WorkflowRegistrationReadinessResult {
  // 1. Validate parameter boundaries
  if (!check.workflowId || check.workflowId === "00000000-0000-0000-0000-000000000000") {
    return {
      outcome: "refused",
      reasonCode: "invalid_workflow_identity",
      reasonMessage: "Workflow identity is invalid or nil",
    };
  }

  if (!check.organizationId || check.organizationId === "00000000-0000-0000-0000-000000000000") {
    return {
      outcome: "refused",
      reasonCode: "invalid_organization_identity",
      reasonMessage: "Organization identity is invalid or nil",
    };
  }

  if (
    typeof check.expectedRevision !== "number" ||
    !Number.isSafeInteger(check.expectedRevision) ||
    check.expectedRevision < 1
  ) {
    return {
      outcome: "refused",
      reasonCode: "invalid_workflow_revision",
      reasonMessage: "Expected workflow revision is invalid",
    };
  }

  // 2. Locate workflow in registered evidence
  const matchingWorkflow = evidence.find((w) => w.workflowId === check.workflowId);

  if (!matchingWorkflow) {
    return {
      outcome: "refused",
      reasonCode: "archive_workflow_not_registered",
      reasonMessage: `Active workflow ${check.workflowId} is not registered in runtime workflows`,
    };
  }

  // 3. Organization isolation check
  if (matchingWorkflow.organizationId !== check.organizationId) {
    return {
      outcome: "refused",
      reasonCode: "wrong_organization",
      reasonMessage: `Workflow belongs to organization ${matchingWorkflow.organizationId}, not ${check.organizationId}`,
    };
  }

  // 4. Permanent application scope and authorization check
  if (!check.applicationRootId) {
    return {
      outcome: "refused",
      reasonCode: "archive_workflow_scope_mismatch",
      reasonMessage:
        "Organisation-shared policy cannot activate archive_workflow because registered workflows require permanent application scope",
    };
  }

  if (!matchingWorkflow.authorizedApplicationIds.includes(check.applicationRootId)) {
    return {
      outcome: "refused",
      reasonCode: "archive_workflow_scope_mismatch",
      reasonMessage: `Registered workflow ${check.workflowId} is not authorized for permanent application root ${check.applicationRootId}`,
    };
  }

  // 5. Revision match check
  if (matchingWorkflow.workflowRevision !== check.expectedRevision) {
    return {
      outcome: "refused",
      reasonCode: "stale_revision",
      reasonMessage: `Workflow active revision (${matchingWorkflow.workflowRevision}) does not match expected revision (${check.expectedRevision})`,
    };
  }

  // 6. Active state check
  if (matchingWorkflow.state !== "active") {
    return {
      outcome: "refused",
      reasonCode: "workflow_not_active",
      reasonMessage: `Workflow state is ${matchingWorkflow.state}, expected active`,
    };
  }

  // 7. Fingerprint verification check
  if (
    check.expectedFingerprint &&
    metadata?.verifiedFlowFingerprint &&
    check.expectedFingerprint !== metadata.verifiedFlowFingerprint
  ) {
    return {
      outcome: "refused",
      reasonCode: "stale_fingerprint",
      reasonMessage: "Expected fingerprint does not match verified flow fingerprint",
    };
  }

  // 8. Destination compatibility check
  if (check.archiveDestination && metadata?.supportedDestinations) {
    if (!metadata.supportedDestinations.includes(check.archiveDestination)) {
      return {
        outcome: "refused",
        reasonCode: "destination_mismatch",
        reasonMessage: `Workflow does not support archive destination "${check.archiveDestination}"`,
      };
    }
  }

  return {
    outcome: "ready",
    workflowId: matchingWorkflow.workflowId,
    workflowRevision: matchingWorkflow.workflowRevision,
    organizationId: matchingWorkflow.organizationId,
    applicationRootId: check.applicationRootId,
    state: "active",
    definitionFingerprint: check.expectedFingerprint ?? "sha256:" + "0".repeat(64),
    verifiedFlowFingerprint: metadata?.verifiedFlowFingerprint ?? "sha256:" + "0".repeat(64),
    supportedDestinations: metadata?.supportedDestinations ? [...metadata.supportedDestinations] : [],
  };
}
