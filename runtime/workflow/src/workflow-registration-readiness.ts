import "server-only";

import {
  applicationRootIdSchema,
  archiveDestinationReferenceSchema,
  fingerprintSchema,
  organizationIdSchema,
  registeredWorkflowReadinessEvidenceSchema,
  revisionSchema,
  workflowIdSchema,
  workflowRegistrationReadinessReasonCodeSchema,
  workflowRegistrationReadinessResultSchema,
  type ApplicationRootId,
  type ArchiveDestinationReference,
  type Fingerprint,
  type OrganizationId,
  type RegisteredWorkflowReadinessEvidence,
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
  archiveDestination?: ArchiveDestinationReference | string | null;
  expectedFingerprint?: Fingerprint | string | null;
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
 * returning complete, validated `RegisteredWorkflowReadinessEvidence` items with non-optional
 * definition fingerprints, verified flow fingerprints, and supported destinations.
 */
export async function readRegisteredWorkflowEvidence(
  transaction: RequestDatabaseTransaction,
  input: {
    organizationId: OrganizationId;
    applicationRootId?: ApplicationRootId | null;
  },
): Promise<readonly RegisteredWorkflowReadinessEvidence[]> {
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
  const evidenceList: RegisteredWorkflowReadinessEvidence[] = [];

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

    const definitionFingerprint = fingerprintSchema.parse(row.definition_fingerprint);
    const verifiedFlowFingerprint = fingerprintSchema.parse(row.verified_flow_fingerprint);

    const rawDestinations = Array.isArray(row.supported_destinations)
      ? row.supported_destinations
      : [];
    const supportedDestinations: ArchiveDestinationReference[] = rawDestinations.map((d) =>
      archiveDestinationReferenceSchema.parse(d),
    );

    const parsedItem = registeredWorkflowReadinessEvidenceSchema.parse({
      workflowId: rawWorkflowId,
      workflowRevision: numericRevision,
      organizationId: rawOrgId,
      authorizedApplicationIds,
      state: "active",
      definitionFingerprint,
      verifiedFlowFingerprint,
      supportedDestinations,
    });

    evidenceList.push(parsedItem);
  }

  return Object.freeze(evidenceList);
}

/**
 * Pure evaluation helper: checks readiness of an archive workflow policy
 * against authoritative registered workflow readiness evidence.
 *
 * Consumes complete, validated, non-optional evidence and enforces
 * exact parity with SQL readiness semantics:
 *   - Workflow root exists and belongs to matching organization
 *   - Workflow is authorized for the requested permanent application root
 *   - Exact revision match in active state
 *   - Expected fingerprint matches either definition or verified-flow fingerprint
 *   - Requested destination belongs to supported destinations
 *
 * Fails closed on any missing, nil, or incoherent proof; never manufactures values.
 */
export function evaluateWorkflowRegistrationReadinessLocally(
  check: WorkflowRegistrationReadinessInput,
  evidence: readonly RegisteredWorkflowReadinessEvidence[],
): WorkflowRegistrationReadinessResult {
  // 1. Validate parameter boundaries
  const nilUuid = "00000000-0000-0000-0000-000000000000";

  if (!check.workflowId || check.workflowId === nilUuid) {
    return {
      outcome: "refused",
      reasonCode: "invalid_workflow_identity",
      reasonMessage: "Workflow identity is missing or nil",
    };
  }

  const parsedWorkflowId = workflowIdSchema.safeParse(check.workflowId);
  if (!parsedWorkflowId.success) {
    return {
      outcome: "refused",
      reasonCode: "invalid_workflow_identity",
      reasonMessage: "Workflow identity is invalid",
    };
  }

  if (!check.organizationId || check.organizationId === nilUuid) {
    return {
      outcome: "refused",
      reasonCode: "invalid_organization_identity",
      reasonMessage: "Organization identity is missing or nil",
    };
  }

  const parsedOrgId = organizationIdSchema.safeParse(check.organizationId);
  if (!parsedOrgId.success) {
    return {
      outcome: "refused",
      reasonCode: "invalid_organization_identity",
      reasonMessage: "Organization identity is invalid",
    };
  }

  if (
    typeof check.expectedRevision !== "number" ||
    !Number.isSafeInteger(check.expectedRevision) ||
    check.expectedRevision < 1 ||
    check.expectedRevision > 9007199254740991
  ) {
    return {
      outcome: "refused",
      reasonCode: "invalid_workflow_revision",
      reasonMessage: "Expected workflow revision is out of range",
    };
  }

  if (check.applicationRootId !== null && check.applicationRootId !== undefined) {
    if (check.applicationRootId === nilUuid) {
      return {
        outcome: "refused",
        reasonCode: "invalid_application_identity",
        reasonMessage: "Application identity is nil UUID",
      };
    }
    const parsedAppId = applicationRootIdSchema.safeParse(check.applicationRootId);
    if (!parsedAppId.success) {
      return {
        outcome: "refused",
        reasonCode: "invalid_application_identity",
        reasonMessage: "Application identity is invalid",
      };
    }
  }

  if (check.archiveDestination !== undefined && check.archiveDestination !== null) {
    const parsedDest = archiveDestinationReferenceSchema.safeParse(check.archiveDestination);
    if (!parsedDest.success) {
      return {
        outcome: "refused",
        reasonCode: "invalid_archive_destination",
        reasonMessage:
          "Archive destination reference must be a lowercase alphanumeric identifier using hyphen or underscore delimiters (max 80 chars)",
      };
    }
  }

  if (check.expectedFingerprint !== undefined && check.expectedFingerprint !== null) {
    const parsedFp = fingerprintSchema.safeParse(check.expectedFingerprint);
    if (!parsedFp.success) {
      return {
        outcome: "refused",
        reasonCode: "stale_fingerprint",
        reasonMessage: "Expected fingerprint format is invalid",
      };
    }
  }

  // 2. Locate workflow in registered evidence
  const matchingWorkflow = evidence.find(
    (w) => w.workflowId.toLowerCase() === check.workflowId.toLowerCase(),
  );

  if (!matchingWorkflow) {
    return {
      outcome: "refused",
      reasonCode: "archive_workflow_not_registered",
      reasonMessage: "Workflow is not registered in runtime workflows",
    };
  }

  // 3. Organization isolation check
  if (matchingWorkflow.organizationId !== check.organizationId) {
    return {
      outcome: "refused",
      reasonCode: "wrong_organization",
      reasonMessage: "Workflow belongs to a different organization",
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
      reasonMessage: "Registered workflow is not authorized for permanent application root",
    };
  }

  // 5. Revision match check
  if (matchingWorkflow.workflowRevision !== check.expectedRevision) {
    return {
      outcome: "refused",
      reasonCode: "stale_revision",
      reasonMessage: "Expected workflow revision does not exist",
    };
  }

  // 6. Active state check
  if (matchingWorkflow.state !== "active") {
    return {
      outcome: "refused",
      reasonCode: "workflow_not_active",
      reasonMessage: "Workflow revision is not in active state",
    };
  }

  // 7. Fingerprint verification check (strict parity with SQL)
  // SQL: p_expected_fingerprint = definition_fingerprint OR p_expected_fingerprint = verified_flow_fingerprint
  if (check.expectedFingerprint) {
    const matchesDefinition = check.expectedFingerprint === matchingWorkflow.definitionFingerprint;
    const matchesVerifiedFlow =
      check.expectedFingerprint === matchingWorkflow.verifiedFlowFingerprint;

    if (!matchesDefinition && !matchesVerifiedFlow) {
      return {
        outcome: "refused",
        reasonCode: "stale_fingerprint",
        reasonMessage:
          "Expected fingerprint does not match workflow definition or verified flow fingerprint",
      };
    }
  }

  // 8. Destination compatibility check
  if (check.archiveDestination) {
    if (!matchingWorkflow.supportedDestinations.includes(check.archiveDestination as ArchiveDestinationReference)) {
      return {
        outcome: "refused",
        reasonCode: "destination_mismatch",
        reasonMessage: "Workflow revision does not support the requested archive destination",
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
    definitionFingerprint: matchingWorkflow.definitionFingerprint,
    verifiedFlowFingerprint: matchingWorkflow.verifiedFlowFingerprint,
    supportedDestinations: [...matchingWorkflow.supportedDestinations],
  };
}
