import { z } from "zod";
import {
  identitySessionSchema,
  organizationSelectionCandidateSchema,
  type IdentitySession,
  type OrganizationSelectionCandidate,
} from "../access/identity-access";
import type { JsonValue } from "../catalogue/common";
import { recordIdSchema, revisionSchema } from "../catalogue/identifiers";
import type {
  ExecuteNamedActionResult,
  InstalledNamedActionReference,
} from "../records/named-actions";
import type {
  ViewerSafeRecordPinAcquisitionResult,
  ViewerSafeRecordPinSelector,
} from "../records/record-links";
import type { SaveRecordCommand } from "../records/records";
import type {
  FlowDefinition,
  FlowReadFieldsScalarType,
  FlowTriggerOrigin,
} from "../workflows/flow-contracts";
import type { FlowRefusalFeedback } from "../workflows/flow-refusal-feedback";
import type { FlowPlan } from "../workflows/flow-plan";
import type { FlowWarningNotice } from "../workflows/form-continuation-contracts";
import { formContinuationAnswerSchema } from "../workflows/form-continuation-answer";
import type { RecordSaveServiceResult } from "../records/save-record";
import type { HumanOrganizationRequestResult } from "../access/human-organization-request";
import type { ActionFlowRunner } from "../rules/action-flow-run";
import type { BeforeSaveRuleWarning } from "../rules/before-save-flow-run";
import type {
  FlowFailureCode,
  FlowFailureOutcome,
  FlowInterfaceIntent,
  FlowLibrary,
  FlowRuntimeValues,
} from "../rules/flow-interpreter";
import type { ProtectedOperationExecutor } from "./protected-operation-executor";
import { flowIdSchema } from "../catalogue/identifiers";

/**
 * The exact set of compiled flows one run is bound to. `releaseKey` identifies that exact release
 * (for example the installed application's release evidence), so a continuation can only ever
 * resume against the flows it started with.
 */
export type FlowRelease = Readonly<{
  releaseKey: string;
  /** The release's planned flows (`flowPlansOf`), validated once per release. */
  flows: ReadonlyMap<string, FlowDefinition>;
  /** The same release's segment plans, compiled together with the flow definitions. */
  plans: ReadonlyMap<string, FlowPlan>;
  /** The release's record types by lower-case record type id, for the values of a Save record task. */
  recordTypes?: ReadonlyMap<string, FlowRecordType>;
  /** The release's named actions by action key, for a Call protected operation task naming one. */
  namedActions?: ReadonlyMap<string, FlowNamedAction>;
  /** Exact trusted selected-record projections, keyed by flow id then task id. */
  selectedRecordReadProjections?: ReadonlyMap<
    string,
    ReadonlyMap<string, FlowSelectedRecordReadProjection>
  >;
}>;

/** One compiler-typed field in a release's selected-record read projection. */
type FlowSelectedRecordReadField = Readonly<{
  alias: string;
  fieldId: string;
  type: FlowReadFieldsScalarType;
}>;

/** Trusted immutable projection of one compiled record.read_fields task. */
export type FlowSelectedRecordReadProjection = Readonly<{
  recordTypeId: string;
  fields: readonly FlowSelectedRecordReadField[];
}>;

/** One record type of a release: each field's identity by its key and by its own identity. */
export type FlowRecordType = Readonly<{
  /** Lower-case field key or field id, to the field id. */
  fieldIds: ReadonlyMap<string, string>;
  /** Lower-case choice field id, to each of its options (by value) that a named action sets. */
  optionActions: ReadonlyMap<string, ReadonlyMap<string, FlowNamedAction>>;
}>;

/** A named action of a release: the one installed action a task names by its key. */
export type FlowNamedAction = Readonly<{
  action: InstalledNamedActionReference;
  /** The record type the action runs on. */
  subjectRecordTypeId: string;
  /**
   * The one record type of each record reference input that names exactly one. A flow holds a
   * record reference as the record's ID; the action takes it as a typed link.
   */
  referenceInputTypes: Readonly<Record<string, string>>;
}>;

/**
 * The protected save a Save record task runs through: the ordinary-human base save of the
 * record service (`createRecordSaveService`), in its own transaction under the initiator's verified
 * request. It owns every access, field, rule, calculation and revision decision.
 */
type RecordSaveTaskPort = Readonly<{
  save(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: SaveRecordCommand,
  ): Promise<RecordSaveServiceResult>;
}>;

/** Confirms that the initiator can currently read a claimed page subject of the exact record type. */
type FlowSubjectReadPort = Readonly<{
  read(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    subject: Readonly<{ recordTypeId: string; recordId: string }>,
  ): Promise<"read" | "refused" | "temporarily_unavailable">;
}>;

/** The current protected read result; unavailable is intentionally indistinguishable. */
type FlowSelectedRecordReadResult =
  | Readonly<{ outcome: "read"; values: Readonly<Record<string, JsonValue>> }>
  | Readonly<{ outcome: "unavailable" }>;

/** Fresh protected read for the current person and one selected record. */
type FlowSelectedRecordReadPort = Readonly<{
  readFields(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    target: Readonly<{
      recordTypeId: string;
      recordId: string;
      fieldIds: readonly string[];
    }>,
  ): Promise<HumanOrganizationRequestResult<FlowSelectedRecordReadResult>>;
}>;

/**
 * The record an interactive flow runs for, read afresh under the initiator's current access with
 * field-level read policy applied: every field of its record type, keyed by field key and typed by
 * the field's type, where a field the initiator may not read is empty. A record the initiator may
 * not read is unavailable, indistinguishably from one that does not exist.
 */
export type FlowCurrentRecordRead =
  Readonly<{ outcome: "read"; values: FlowRuntimeValues }> | Readonly<{ outcome: "unavailable" }>;

type FlowCurrentRecordPort = Readonly<{
  read(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    target: Readonly<{ recordTypeId: string; recordId: string }>,
  ): Promise<FlowCurrentRecordRead>;
}>;

/**
 * What the record service runs for a named action: it prepares the action's subject under
 * the actor's authority, calls the supplied flow run inside its own transaction, and applies every
 * record change the flow collected in one apply record changes call. The result is the closed
 * named-action result; any before-save rule warnings travel beside it.
 */
type NamedActionRecordPort = Readonly<{
  execute(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: unknown,
    run: ActionFlowRunner,
  ): Promise<
    HumanOrganizationRequestResult<ExecuteNamedActionResult> &
      Readonly<{ warnings?: readonly BeforeSaveRuleWarning[] }>
  >;
}>;

export type NamedActionExecutionResult = Awaited<ReturnType<NamedActionRecordPort["execute"]>>;

export type FlowOrchestratorDependencies = Readonly<{
  executor: Pick<ProtectedOperationExecutor, "execute">;
  /** Runs named-action flows; without it an action is unavailable. */
  actionRecords?: NamedActionRecordPort;
  /** Runs Save record tasks; without it a Save record task is unavailable. */
  records?: RecordSaveTaskPort;
  /** Verifies the viewer's read access to a claimed page subject before a protected change. */
  subjects?: FlowSubjectReadPort;
  /** Reads selected fields afresh; its result is never entered into the protected effect ledger. */
  selectedRecordReads?: FlowSelectedRecordReadPort;
  /**
   * Reads the record a flow with a record input runs for, at its start and again at every resume,
   * so a stored run never holds record values. Without it such a flow cannot start.
   */
  currentRecords?: FlowCurrentRecordPort;
  /** Acquires a current installed identity for a human; no display values or replayed read results. */
  recordPins?: Readonly<{
    acquireIdentity(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      selector: ViewerSafeRecordPinSelector,
    ): Promise<ViewerSafeRecordPinAcquisitionResult>;
  }>;
  /**
   * Resolves the flows of the release the organisation runs for a flow id, from trusted
   * installation state. `undefined` refuses the start without saying why.
   */
  resolveRelease: (organizationId: string, flowId: string) => Promise<FlowRelease | undefined>;
  /**
   * Checks a flow's invocation permission for the initiator. Required whenever the started flow, or
   * any flow it can reach through Run flow, declares one; such a flow is unavailable to the run when
   * this is not supplied.
   */
  authorizeInvocation?: (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    flow: FlowDefinition,
  ) => Promise<boolean>;
  /** The initiator's organisation account, for `{{ execution.actor }}`; absent means unresolved. */
  resolveActor?: (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
  ) => Promise<string | undefined>;
  now?: () => Date;
  /** A monotonic clock in milliseconds, for the server-time limit. */
  clock?: () => number;
  newRunId?: () => string;
  newToken?: () => string;
}>;

export const subjectSchema = z
  .object({
    recordId: recordIdSchema,
    revision: revisionSchema.max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict();

export const startRequestSchema = z
  .object({
    session: identitySessionSchema,
    selection: organizationSelectionCandidateSchema,
    binding: z
      .object({
        flowId: flowIdSchema,
        inputs: z.record(z.string(), z.unknown()).default({}),
      })
      .strict(),
    /** The page record and revision the surface showed; it remains evidence across pauses. */
    subject: subjectSchema.optional(),
  })
  .strict();

export const resumeRequestSchema = z
  .object({
    session: identitySessionSchema,
    selection: organizationSelectionCandidateSchema,
    flowId: flowIdSchema,
    continuation: z.string().min(16).max(128),
    answer: formContinuationAnswerSchema,
  })
  .strict();

export type FlowStartRequest = z.input<typeof startRequestSchema>;
export type FlowResumeRequest = z.input<typeof resumeRequestSchema>;

/**
 * What a caller last saw, compared with trusted server state before a run starts or resumes. It is
 * evidence, never authority: any difference refuses the call. A mismatch found only in the stored
 * run (its node, run id or committed effects) is found after the single-use continuation is
 * consumed, so a stale or forged continuation is spent and the person restarts.
 */
export type FlowRunExpectation = Readonly<{
  /** The exact release of the flow set; must equal the release trusted installation state resolves. */
  releaseKey: string;
  /** The paused node the caller answers; the stored run must be paused at exactly this node. */
  pausedAt?: Readonly<{ nodeId: string; awaiting: "form" | "confirm" }>;
  /** The receipt the caller holds; the stored run must be that run with that many committed effects. */
  receipt?: Readonly<{ runId: string; committedEffects: number }>;
}>;

/** Why a task did not run: the located, fail-closed capability outcome. */
export type FlowUnavailableNotice = Readonly<{
  taskId: string;
  taskType: string;
  code: "capability_unavailable";
  message: string;
}>;

export type SafeIntent = Readonly<{
  kind: FlowInterfaceIntent["kind"];
  taskId: string;
  properties: Readonly<Record<string, JsonValue>>;
}>;

export type FlowOrchestratorResponse =
  | Readonly<{
      kind: "finished";
      warnings: readonly FlowWarningNotice[];
      runId: string;
      /**
       * `committed` when at least one protected effect committed, `completed` when the flow ran to
       * its end without one, and otherwise the safe failure outcome.
       */
      outcome: "committed" | "completed" | FlowFailureOutcome;
      /** Set only for a failure: which rule ended the run, and at which task. */
      failure?: Readonly<{
        code: FlowFailureCode;
        taskId?: string;
        diagnostic?: FlowRefusalFeedback;
      }>;
      stopped?: string;
      /** Protected effects this run committed, across every resume: a later failure is then partial. */
      committedEffects: number;
      outputs: Readonly<Record<string, JsonValue>>;
      intents: readonly SafeIntent[];
      unavailable: readonly FlowUnavailableNotice[];
    }>
  | Readonly<{
      kind: "suspended";
      runId: string;
      awaiting: "form" | "confirm";
      /** The paused node (task id) the continuation resumes, and the release the run is bound to. */
      nodeId: string;
      releaseKey: string;
      committedEffects: number;
      /** The typed intent for the page or MCP client, ending with the form or confirmation. */
      intents: readonly SafeIntent[];
      continuation: string;
      expiresAt: string;
      unavailable: readonly FlowUnavailableNotice[];
    }>
  | Readonly<{ kind: "refused" }>;

type RunAuthority = Readonly<{
  kind: "person";
  session: IdentitySession;
  selection: OrganizationSelectionCandidate;
}>;

export type PreparedPersonRun = Readonly<{
  session: IdentitySession;
  selection: OrganizationSelectionCandidate;
  flowId: string;
  release: FlowRelease;
  library: FlowLibrary;
}>;

export type Run = {
  authority: RunAuthority;
  origin: FlowTriggerOrigin;
  originId: string;
  flowId: string;
  release: FlowRelease;
  library: FlowLibrary;
  /** Server milliseconds already spent by earlier segments of this run. */
  carriedMilliseconds: number;
  segmentStart: number;
  unavailable: FlowUnavailableNotice[];
  warnings: FlowWarningNotice[];
  /** Tasks whose refusal the named-action port already logged with its reason. */
  refusalLoggedTaskIds: string[];
  /**
   * The raw values of declared sensitive outputs this segment received, held in memory only, so
   * nothing that carries one is stored or handed to another protected operation.
   */
  sensitive: string[];
  /** This segment cannot persist interpreter state after any selected values enter it. */
  selectedRecordReadSeen: boolean;
  /** A pin-derived save must resolve its exact command receipt on an effect-ledger replay. */
  recordPinReadSeen?: boolean;
};
