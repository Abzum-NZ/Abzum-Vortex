import "server-only";

import {
  applicationRootIdSchema,
  installationWorkflowActivationPlanSchema,
  installationWorkflowWithdrawalReconciliationSchema,
  organizationIdSchema,
  revisionSchema,
  stableDefinitionReleaseVersionSchema,
  workflowRunIdSchema,
  type ApplicationRootId,
  type InstallationWorkflowActivationEvidence,
  type InstallationWorkflowActivationPlan,
  type InstallationWorkflowFlowReference,
  type InstallationWorkflowReadinessRefusalReason,
  type InstallationWorkflowRegisteredFlow,
  type InstallationWorkflowRetainedStart,
  type InstallationWorkflowScheduleChange,
  type InstallationWorkflowWithdrawalReconciliation,
  type OrganizationId,
  type SemanticVersion,
  type WorkflowRunId,
} from "@vortex/contracts";
import {
  kestraFlowCompilerEnvironments,
  type KestraFlowCompilerEnvironment,
  type KestraFlowIdentity,
} from "./kestra-compiler";
import type {
  KestraFlowRegistrationCommand,
  KestraFlowRegistrationResult,
} from "./flow-registration-repository";

/**
 * #662: installation activation and withdrawal readiness over the #661 flow
 * registrations.
 *
 * #661 part A compiles each exact published workflow of one Application release
 * into a deterministic inactive Kestra candidate, and #661 part B registers it
 * as one exact installation identity mapping. This module is the missing
 * readiness step the #64 installation lifecycle consumes:
 *
 * - `planInstallationWorkflowActivation` refuses to name activation evidence
 *   unless every expected workflow of the candidate release is registered
 *   inactive with the exact generated namespace, flow id and identity. A refusal
 *   is not activation evidence, so a partial registration can never switch the
 *   active revision and the previously active exact release stays selected. A
 *   ready plan additionally names the idempotent schedule reconciliation and
 *   every accepted start, pinned to the exact revision it was accepted under, so
 *   an ordinary upgrade cannot retarget or drop it.
 * - `reconcileInstallationWorkflowWithdrawal` blocks new acceptance, disables
 *   the withdrawn release's schedules and settles every accepted start with an
 *   explicit refusal or cancellation request while retaining the run reference.
 *
 * This module is pure. It performs no I/O, calls no Kestra API, compiles no
 * flow, and never invents an identity, revision, fingerprint or authority from
 * its inputs: every value is either the exact permanent identity the caller
 * supplied or the exact stored registration #661 produced.
 */

export const installationWorkflowReadinessErrorCodes = [
  "INVALID_INSTALLATION_WORKFLOW_READINESS_INPUT",
] as const;

export type InstallationWorkflowReadinessErrorCode =
  (typeof installationWorkflowReadinessErrorCodes)[number];

export class InstallationWorkflowReadinessError extends Error {
  readonly code: InstallationWorkflowReadinessErrorCode;

  constructor(code: InstallationWorkflowReadinessErrorCode) {
    super(code);
    this.name = "InstallationWorkflowReadinessError";
    this.code = code;
  }
}

/**
 * The five permanent identity fields an activation or withdrawal targets. The
 * sixth identity field, `workflowRevision`, belongs to one workflow rather than
 * the installation. `installationRevision` is the Application release revision
 * the #64 activation switches to, so readiness evidence and the activation
 * command share one target.
 */
export type InstallationWorkflowInstallationIdentity = Readonly<{
  environment: KestraFlowCompilerEnvironment;
  organizationId: OrganizationId;
  applicationRootId: ApplicationRootId;
  applicationVersion: SemanticVersion;
  installationRevision: number;
}>;

/** One expected workflow: its exact #661 identity and compiled inactive candidate. */
export type InstallationWorkflowExpectedCandidate = KestraFlowRegistrationCommand;

/** One accepted start intent the installation retains. */
export type AcceptedInstallationWorkflowStart = Readonly<{
  runId: WorkflowRunId;
  /** The exact Application release revision the start was accepted under. */
  applicationReleaseRevision: number;
  /** The exact workflow revision the start was accepted under. */
  workflowRevision: number;
  /** Whether execution has begun; an unstarted accepted start is refused on withdrawal. */
  started: boolean;
}>;

/** The complete input of one activation readiness decision. */
export type InstallationWorkflowActivationRequest = Readonly<{
  target: InstallationWorkflowInstallationIdentity;
  candidates: readonly InstallationWorkflowExpectedCandidate[];
  registrations: readonly KestraFlowRegistrationResult[];
  /** The superseded active release's registered flows, whose schedules are disabled. */
  supersededFlows?: readonly InstallationWorkflowFlowReference[];
  /** Starts already accepted by the installation before this activation. */
  acceptedStarts?: readonly AcceptedInstallationWorkflowStart[];
}>;

/** The complete input of one withdrawal reconciliation. */
export type InstallationWorkflowWithdrawalRequest = Readonly<{
  target: InstallationWorkflowInstallationIdentity;
  /** The withdrawn release's registered flows. */
  flows: readonly InstallationWorkflowRegisteredFlow[];
  /** Every start the installation accepted, in any state. */
  acceptedStarts: readonly AcceptedInstallationWorkflowStart[];
}>;

const targetKeys = [
  "environment",
  "organizationId",
  "applicationRootId",
  "applicationVersion",
  "installationRevision",
] as const;

const identityKeys = [...targetKeys, "workflowRevision"] as const;

const workflowTriggerKinds = [
  "event",
  "schedule",
  "incoming_message",
  "button",
  "interface",
  "workflow",
] as const;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean => Object.keys(value).every((key) => allowed.includes(key));

const sameIdentifier = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const isEnvironment = (value: unknown): value is KestraFlowCompilerEnvironment =>
  typeof value === "string" &&
  (kestraFlowCompilerEnvironments as readonly string[]).includes(value);

const invalidInput = (): InstallationWorkflowReadinessError =>
  new InstallationWorkflowReadinessError("INVALID_INSTALLATION_WORKFLOW_READINESS_INPUT");

const refusedPlan = (
  reason: InstallationWorkflowReadinessRefusalReason,
): InstallationWorkflowActivationPlan => ({ outcome: "refused", reason });

/**
 * Validates exactly the six identity fields and canonicalises the UUIDs to
 * lower case, exactly as the #661 compiler and registration repository do, so
 * one identity always names one installation.
 */
const parseIdentity = (candidate: unknown): KestraFlowIdentity | undefined => {
  if (!isObject(candidate) || !hasOnlyKeys(candidate, identityKeys)) return undefined;
  if (!isEnvironment(candidate.environment)) return undefined;

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
    environment: candidate.environment,
    organizationId: organizationId.data.toLowerCase() as OrganizationId,
    applicationRootId: applicationRootId.data.toLowerCase() as ApplicationRootId,
    applicationVersion: applicationVersion.data,
    installationRevision: installationRevision.data,
    workflowRevision: workflowRevision.data,
  });
};

/** Validates the five installation fields, refusing any extra or missing field. */
const parseTarget = (
  candidate: unknown,
): InstallationWorkflowInstallationIdentity | undefined => {
  if (!isObject(candidate) || !hasOnlyKeys(candidate, targetKeys)) return undefined;
  const identity = parseIdentity({ ...candidate, workflowRevision: 1 });
  if (identity === undefined) return undefined;
  return Object.freeze({
    environment: identity.environment,
    organizationId: identity.organizationId,
    applicationRootId: identity.applicationRootId,
    applicationVersion: identity.applicationVersion,
    installationRevision: identity.installationRevision,
  });
};

const sameTargetIdentity = (
  target: InstallationWorkflowInstallationIdentity,
  identity: KestraFlowIdentity,
): boolean =>
  target.environment === identity.environment &&
  sameIdentifier(target.organizationId, identity.organizationId) &&
  sameIdentifier(target.applicationRootId, identity.applicationRootId) &&
  target.applicationVersion === identity.applicationVersion &&
  target.installationRevision === identity.installationRevision;

const sameWorkflowIdentity = (left: KestraFlowIdentity, right: KestraFlowIdentity): boolean =>
  left.environment === right.environment &&
  sameIdentifier(left.organizationId, right.organizationId) &&
  sameIdentifier(left.applicationRootId, right.applicationRootId) &&
  left.applicationVersion === right.applicationVersion &&
  left.installationRevision === right.installationRevision &&
  left.workflowRevision === right.workflowRevision;

type ParsedCandidate = Readonly<{
  identity: KestraFlowIdentity;
  flowId: string;
  namespace: string;
  scheduled: boolean;
}>;

/**
 * Reads only the compiled inactive candidate identity and provider identifiers.
 * The candidate's task bodies are never used: this module does not compile or
 * interpret flows. An active candidate, a revision that disagrees with its
 * identity or an unknown trigger kind is refused.
 */
const parseCandidate = (candidate: unknown): ParsedCandidate | undefined => {
  if (!isObject(candidate) || !hasOnlyKeys(candidate, ["identity", "flow"])) return undefined;
  const identity = parseIdentity(candidate.identity);
  if (identity === undefined) return undefined;

  const flow = candidate.flow;
  if (!isObject(flow) || flow.active !== false) return undefined;
  if (
    typeof flow.workflowRevision !== "number" ||
    flow.workflowRevision !== identity.workflowRevision ||
    typeof flow.id !== "string" ||
    flow.id.length < 1 ||
    flow.id.length > 100 ||
    typeof flow.namespace !== "string" ||
    flow.namespace.length < 1 ||
    flow.namespace.length > 150
  )
    return undefined;

  const trigger = isObject(flow.trigger) ? flow.trigger : undefined;
  if (
    trigger === undefined ||
    typeof trigger.kind !== "string" ||
    !(workflowTriggerKinds as readonly string[]).includes(trigger.kind)
  )
    return undefined;

  return Object.freeze({
    identity,
    flowId: flow.id,
    namespace: flow.namespace,
    scheduled: trigger.kind === "schedule",
  });
};

type ParsedRegistration =
  | Readonly<{
      outcome: "present";
      identity: KestraFlowIdentity;
      flowId: string;
      namespace: string;
      candidateFingerprint: string;
    }>
  | Readonly<{ outcome: "refused" }>;

const parseRegistrationIdentity = (
  value: Readonly<Record<string, unknown>>,
): KestraFlowIdentity | undefined =>
  parseIdentity({
    environment: value.environment,
    organizationId: value.organizationId,
    applicationRootId: value.applicationRootId,
    applicationVersion: value.applicationVersion,
    installationRevision: value.installationRevision,
    workflowRevision: value.workflowRevision,
  });

/** Reads one exact #661 registration result; a changed-candidate refusal is the only refusal. */
const parseRegistrationResult = (candidate: unknown): ParsedRegistration | undefined => {
  if (!isObject(candidate)) return undefined;

  if (candidate.outcome === "refused") {
    if (
      !hasOnlyKeys(candidate, ["outcome", "reasonCode"]) ||
      candidate.reasonCode !== "candidate_changed"
    )
      return undefined;
    return { outcome: "refused" };
  }
  if (candidate.outcome !== "registered" && candidate.outcome !== "existing") return undefined;
  if (!hasOnlyKeys(candidate, ["outcome", "registration"])) return undefined;

  const registration = candidate.registration;
  if (!isObject(registration)) return undefined;
  const identity = parseRegistrationIdentity(registration);
  if (identity === undefined) return undefined;
  if (
    typeof registration.flowId !== "string" ||
    registration.flowId.length < 1 ||
    registration.flowId.length > 100 ||
    typeof registration.namespace !== "string" ||
    registration.namespace.length < 1 ||
    registration.namespace.length > 150 ||
    typeof registration.candidateFingerprint !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(registration.candidateFingerprint) ||
    registration.status !== "inactive"
  )
    return undefined;

  return {
    outcome: "present",
    identity,
    flowId: registration.flowId,
    namespace: registration.namespace,
    candidateFingerprint: registration.candidateFingerprint,
  };
};

const parseFlowReference = (candidate: unknown): InstallationWorkflowFlowReference | undefined => {
  if (!isObject(candidate) || !hasOnlyKeys(candidate, ["workflowRevision", "flowId", "namespace"]))
    return undefined;
  const workflowRevision = revisionSchema.safeParse(candidate.workflowRevision);
  if (
    !workflowRevision.success ||
    typeof candidate.flowId !== "string" ||
    candidate.flowId.length < 1 ||
    candidate.flowId.length > 100 ||
    typeof candidate.namespace !== "string" ||
    candidate.namespace.length < 1 ||
    candidate.namespace.length > 150
  )
    return undefined;
  return Object.freeze({
    workflowRevision: workflowRevision.data,
    flowId: candidate.flowId,
    namespace: candidate.namespace,
  });
};

const parseRegisteredFlow = (candidate: unknown): InstallationWorkflowRegisteredFlow | undefined => {
  if (
    !isObject(candidate) ||
    !hasOnlyKeys(candidate, [
      "workflowRevision",
      "flowId",
      "namespace",
      "candidateFingerprint",
      "status",
      "scheduled",
    ])
  )
    return undefined;
  const reference = parseFlowReference({
    workflowRevision: candidate.workflowRevision,
    flowId: candidate.flowId,
    namespace: candidate.namespace,
  });
  if (reference === undefined) return undefined;
  if (
    typeof candidate.candidateFingerprint !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(candidate.candidateFingerprint) ||
    candidate.status !== "inactive" ||
    typeof candidate.scheduled !== "boolean"
  )
    return undefined;
  return Object.freeze({
    ...reference,
    candidateFingerprint: candidate.candidateFingerprint,
    status: "inactive" as const,
    scheduled: candidate.scheduled,
  });
};

const parseAcceptedStart = (candidate: unknown): AcceptedInstallationWorkflowStart | undefined => {
  if (
    !isObject(candidate) ||
    !hasOnlyKeys(candidate, [
      "runId",
      "applicationReleaseRevision",
      "workflowRevision",
      "started",
    ])
  )
    return undefined;
  const runId = workflowRunIdSchema.safeParse(candidate.runId);
  const applicationReleaseRevision = revisionSchema.safeParse(candidate.applicationReleaseRevision);
  const workflowRevision = revisionSchema.safeParse(candidate.workflowRevision);
  if (
    !runId.success ||
    !applicationReleaseRevision.success ||
    !workflowRevision.success ||
    typeof candidate.started !== "boolean"
  )
    return undefined;
  return Object.freeze({
    runId: runId.data,
    applicationReleaseRevision: applicationReleaseRevision.data,
    workflowRevision: workflowRevision.data,
    started: candidate.started,
  });
};

/**
 * The pure activation readiness decision. It returns ready activation evidence
 * only when every workflow of the candidate release is registered inactive
 * under the exact identity, namespace and flow id the candidate compiled to; a
 * missing, refused or changed registration refuses the whole candidate so the
 * prior active exact release stays selected. It never compiles a flow, calls
 * Kestra or derives an identity.
 */
export const planInstallationWorkflowActivation = (
  inputCandidate: unknown,
): InstallationWorkflowActivationPlan => {
  if (
    !isObject(inputCandidate) ||
    !hasOnlyKeys(inputCandidate, [
      "target",
      "candidates",
      "registrations",
      "supersededFlows",
      "acceptedStarts",
    ])
  )
    return refusedPlan("invalid_input");

  const target = parseTarget(inputCandidate.target);
  if (target === undefined) return refusedPlan("invalid_input");

  const candidatesInput = inputCandidate.candidates;
  if (!Array.isArray(candidatesInput)) return refusedPlan("invalid_input");
  const candidates: ParsedCandidate[] = [];
  for (const candidate of candidatesInput) {
    const parsed = parseCandidate(candidate);
    if (parsed === undefined) return refusedPlan("invalid_input");
    if (!sameTargetIdentity(target, parsed.identity)) return refusedPlan("identity_mismatch");
    candidates.push(parsed);
  }
  const candidateRevisions = candidates.map((candidate) => candidate.identity.workflowRevision);
  const candidateFlowIds = candidates.map((candidate) => candidate.flowId);
  if (
    new Set(candidateRevisions).size !== candidateRevisions.length ||
    new Set(candidateFlowIds).size !== candidateFlowIds.length
  )
    return refusedPlan("duplicate_workflow");
  candidates.sort((left, right) => left.identity.workflowRevision - right.identity.workflowRevision);

  const registrationsInput = inputCandidate.registrations;
  if (!Array.isArray(registrationsInput)) return refusedPlan("invalid_input");
  const registrations: ParsedRegistration[] = [];
  for (const candidate of registrationsInput) {
    const parsed = parseRegistrationResult(candidate);
    if (parsed === undefined) return refusedPlan("invalid_input");
    registrations.push(parsed);
  }
  if (registrations.some((registration) => registration.outcome === "refused"))
    return refusedPlan("refused_registration");

  const present = registrations.filter(
    (registration): registration is Extract<ParsedRegistration, { outcome: "present" }> =>
      registration.outcome === "present",
  );

  const flows: InstallationWorkflowRegisteredFlow[] = [];
  const matched = new Set<number>();
  for (const candidate of candidates) {
    const index = present.findIndex(
      (registration, position) =>
        !matched.has(position) &&
        registration.flowId === candidate.flowId &&
        registration.namespace === candidate.namespace &&
        sameWorkflowIdentity(registration.identity, candidate.identity),
    );
    if (index < 0) return refusedPlan("missing_registration");
    matched.add(index);
    const registration = present[index]!;
    flows.push(
      Object.freeze({
        workflowRevision: candidate.identity.workflowRevision,
        flowId: candidate.flowId,
        namespace: candidate.namespace,
        candidateFingerprint: registration.candidateFingerprint,
        status: "inactive" as const,
        scheduled: candidate.scheduled,
      }),
    );
  }
  if (present.length !== matched.size) return refusedPlan("mismatched_registration");

  const evidence: InstallationWorkflowActivationEvidence = Object.freeze({
    environment: target.environment,
    organizationId: target.organizationId,
    applicationRootId: target.applicationRootId,
    applicationVersion: target.applicationVersion,
    installationRevision: target.installationRevision,
    flows: Object.freeze(flows),
  });

  const scheduleChanges: InstallationWorkflowScheduleChange[] = flows
    .filter((flow) => flow.scheduled)
    .map((flow) =>
      Object.freeze({
        workflowRevision: flow.workflowRevision,
        flowId: flow.flowId,
        namespace: flow.namespace,
        action: "enable" as const,
      }),
    );

  const supersededInput = inputCandidate.supersededFlows;
  if (supersededInput !== undefined) {
    if (!Array.isArray(supersededInput)) return refusedPlan("invalid_input");
    const currentFlows = new Set(flows.map((flow) => `${flow.namespace}\0${flow.flowId}`));
    for (const candidate of supersededInput) {
      const reference = parseFlowReference(candidate);
      if (reference === undefined) return refusedPlan("invalid_input");
      if (currentFlows.has(`${reference.namespace}\0${reference.flowId}`)) continue;
      scheduleChanges.push(Object.freeze({ ...reference, action: "disable" as const }));
    }
  }

  const retainedStarts: InstallationWorkflowRetainedStart[] = [];
  const acceptedInput = inputCandidate.acceptedStarts;
  if (acceptedInput !== undefined) {
    if (!Array.isArray(acceptedInput)) return refusedPlan("invalid_input");
    for (const candidate of acceptedInput) {
      const start = parseAcceptedStart(candidate);
      if (start === undefined) return refusedPlan("invalid_input");
      retainedStarts.push(
        Object.freeze({
          runId: start.runId,
          applicationReleaseRevision: start.applicationReleaseRevision,
          workflowRevision: start.workflowRevision,
        }),
      );
    }
  }

  const plan = Object.freeze({
    outcome: "ready" as const,
    evidence,
    scheduleChanges: Object.freeze(scheduleChanges),
    retainedStarts: Object.freeze(retainedStarts),
  });
  const validated = installationWorkflowActivationPlanSchema.safeParse(plan);
  if (!validated.success) return refusedPlan("invalid_input");
  return validated.data;
};

/**
 * The pure withdrawal reconciliation. It blocks new acceptance, disables every
 * schedule of the withdrawn release and settles each accepted start: an
 * unstarted accepted start is refused with a retained status, an already
 * started execution gets a cancellation request. Every run reference is kept,
 * so execution, mapping, intent and activity history stay explainable instead
 * of being discarded.
 */
export const reconcileInstallationWorkflowWithdrawal = (
  inputCandidate: unknown,
): InstallationWorkflowWithdrawalReconciliation => {
  if (
    !isObject(inputCandidate) ||
    !hasOnlyKeys(inputCandidate, ["target", "flows", "acceptedStarts"])
  )
    throw invalidInput();

  const target = parseTarget(inputCandidate.target);
  if (target === undefined) throw invalidInput();

  const flowsInput = inputCandidate.flows;
  if (!Array.isArray(flowsInput)) throw invalidInput();
  const flows: InstallationWorkflowRegisteredFlow[] = [];
  for (const candidate of flowsInput) {
    const flow = parseRegisteredFlow(candidate);
    if (flow === undefined) throw invalidInput();
    flows.push(flow);
  }

  const acceptedInput = inputCandidate.acceptedStarts;
  if (!Array.isArray(acceptedInput)) throw invalidInput();
  const acceptedStarts: AcceptedInstallationWorkflowStart[] = [];
  for (const candidate of acceptedInput) {
    const start = parseAcceptedStart(candidate);
    if (start === undefined) throw invalidInput();
    acceptedStarts.push(start);
  }

  const reconciliation = Object.freeze({
    organizationId: target.organizationId,
    applicationRootId: target.applicationRootId,
    applicationReleaseRevision: target.installationRevision,
    newAcceptance: "blocked" as const,
    schedulesToDisable: Object.freeze(
      flows
        .filter((flow) => flow.scheduled)
        .map((flow) =>
          Object.freeze({
            workflowRevision: flow.workflowRevision,
            flowId: flow.flowId,
            namespace: flow.namespace,
          }),
        ),
    ),
    starts: Object.freeze(
      acceptedStarts.map((start) =>
        Object.freeze({
          runId: start.runId,
          applicationReleaseRevision: start.applicationReleaseRevision,
          workflowRevision: start.workflowRevision,
          decision: start.started
            ? ("cancellation_requested" as const)
            : ("refused_before_start" as const),
        }),
      ),
    ),
  });
  const validated = installationWorkflowWithdrawalReconciliationSchema.safeParse(reconciliation);
  if (!validated.success) throw invalidInput();
  return validated.data;
};
