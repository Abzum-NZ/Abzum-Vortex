import { z } from "zod";
import {
  applicationRootIdSchema,
  correlationIdSchema,
  flowIdSchema,
  flowLiteralSchema,
  formContinuationAnswerSchema,
  identitySessionSchema,
  moduleRootIdSchema,
  organizationIdSchema,
  organizationSelectionCandidateSchema,
  recordIdSchema,
  revisionSchema,
  stableDefinitionReleaseVersionSchema,
  timestampSchema,
  type ExecuteNamedActionResult,
  type ExecutionAuthorityContext,
  type FlowDefinition,
  type FlowReadFieldsScalarType,
  type FlowRefusalFeedback,
  type FlowTriggerOrigin,
  type IdentitySession,
  type InstalledNamedActionReference,
  type JsonValue,
  type OrganizationSelectionCandidate,
  type SaveRecordCommand,
  type SaveRecordResult,
  type ViewerSafeRecordPinAcquisitionResult,
  type ViewerSafeRecordPinSelector,
} from "../schema";
import type { HumanOrganizationRequestResult } from "../access/index";
import type {
  ActionFlowRunner,
  BeforeSaveRuleWarning,
  FlowFailureCode,
  FlowFailureOutcome,
  FlowInterfaceIntent,
  FlowLibrary,
} from "../rules/index";
import type {
  FlowContinuationStore,
  FlowEffectLedger,
} from "./flow-continuation-store";
import type { ProtectedOperationExecutor } from "./protected-operation-executor";

/**
 * The exact set of compiled flows one run is bound to. `releaseKey` identifies that exact release
 * (for example the installed application's release evidence), so a continuation can only ever
 * resume against the flows it started with.
 */
export type FlowRelease = Readonly<{
  releaseKey: string;
  flows: ReadonlyMap<string, unknown>;
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

/** Exact installation and compiled-flow release identity retained on a committed start intent. */
export const flowReleaseIdentitySchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
    applicationReleaseVersion: stableDefinitionReleaseVersionSchema,
    flowOwnerKind: z.enum(["application", "module"]),
    flowOwnerRootId: z.union([applicationRootIdSchema, moduleRootIdSchema]),
    flowReleaseRevision: revisionSchema,
    flowReleaseVersion: stableDefinitionReleaseVersionSchema,
    flowReleaseFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export type FlowReleaseIdentity = z.infer<typeof flowReleaseIdentitySchema>;

/** Trusted read shape of one committed Event start; callers supply only its intent identifier. */
export const committedFlowStartIntentSchema = z
  .object({
    intentId: z.uuid(),
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
    applicationReleaseVersion: stableDefinitionReleaseVersionSchema,
    flowRelease: z.discriminatedUnion("ownerKind", [
      z
        .object({
          ownerKind: z.literal("application"),
          rootId: applicationRootIdSchema,
          revision: revisionSchema,
          version: stableDefinitionReleaseVersionSchema,
          fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        })
        .strict(),
      z
        .object({
          ownerKind: z.literal("module"),
          rootId: moduleRootIdSchema,
          revision: revisionSchema,
          version: stableDefinitionReleaseVersionSchema,
          fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        })
        .strict(),
    ]),
    flowId: flowIdSchema,
    origin: z.literal("event"),
    originId: z.uuid(),
    trigger: z.object({ type: z.literal("Event"), id: z.string().min(1).max(1300) }).strict(),
    inputs: z.record(z.string().min(1).max(200), flowLiteralSchema),
    triggerValues: z.record(z.string().min(1).max(200), flowLiteralSchema),
    correlationId: correlationIdSchema,
    acceptedAt: timestampSchema,
  })
  .strict()
  .superRefine((intent, context) => {
    if (
      intent.flowRelease.ownerKind === "application" &&
      (intent.flowRelease.rootId !== intent.applicationRootId ||
        intent.flowRelease.revision !== intent.applicationReleaseRevision ||
        intent.flowRelease.version !== intent.applicationReleaseVersion)
    )
      context.addIssue({
        code: "custom",
        path: ["flowRelease"],
        message: "Application flow release differs from the installation",
      });
  });
export type CommittedFlowStartIntent = z.infer<typeof committedFlowStartIntentSchema>;

export const releaseIdentityForIntent = (intent: CommittedFlowStartIntent): FlowReleaseIdentity => ({
  organizationId: intent.organizationId,
  applicationRootId: intent.applicationRootId,
  applicationReleaseRevision: intent.applicationReleaseRevision,
  applicationReleaseVersion: intent.applicationReleaseVersion,
  flowOwnerKind: intent.flowRelease.ownerKind,
  flowOwnerRootId: intent.flowRelease.rootId,
  flowReleaseRevision: intent.flowRelease.revision,
  flowReleaseVersion: intent.flowRelease.version,
  flowReleaseFingerprint: intent.flowRelease.fingerprint,
});

export const flowReleaseIdentityMatches = (
  expected: FlowReleaseIdentity,
  actual: FlowReleaseIdentity,
): boolean =>
  expected.organizationId.toLowerCase() === actual.organizationId.toLowerCase() &&
  expected.applicationRootId.toLowerCase() === actual.applicationRootId.toLowerCase() &&
  expected.applicationReleaseRevision === actual.applicationReleaseRevision &&
  expected.applicationReleaseVersion === actual.applicationReleaseVersion &&
  expected.flowOwnerKind === actual.flowOwnerKind &&
  expected.flowOwnerRootId.toLowerCase() === actual.flowOwnerRootId.toLowerCase() &&
  expected.flowReleaseRevision === actual.flowReleaseRevision &&
  expected.flowReleaseVersion === actual.flowReleaseVersion &&
  expected.flowReleaseFingerprint === actual.flowReleaseFingerprint;

/** One record type of a release: each field's identity by its key and by its own identity. */
export type FlowRecordType = Readonly<{
  /** Lower-case field key or field id, to the field id. */
  fieldIds: ReadonlyMap<string, string>;
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
export type RecordSaveTaskPort = Readonly<{
  save(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: SaveRecordCommand,
  ): Promise<HumanOrganizationRequestResult<SaveRecordResult>>;
}>;

/** Confirms that the initiator can currently read a claimed page subject of the exact record type. */
export type FlowSubjectReadPort = Readonly<{
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
export type FlowSelectedRecordReadPort = Readonly<{
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
 * What the record service runs for a named action: it prepares the action's subject under
 * the actor's authority, calls the supplied flow run inside its own transaction, and applies every
 * record change the flow collected in one apply record changes call. The result is the closed
 * named-action result; any before-save rule warnings travel beside it.
 */
export type NamedActionRecordPort = Readonly<{
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
  /** Acquires a current installed identity for a human; no display values or replayed read results. */
  recordPins?: Readonly<{
    acquireIdentity(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      selector: ViewerSafeRecordPinSelector,
    ): Promise<ViewerSafeRecordPinAcquisitionResult>;
  }>;
  continuations: FlowContinuationStore;
  ledger: FlowEffectLedger;
  /**
   * Resolves the flows of the release the organisation runs for a flow id, from trusted
   * installation state. `undefined` refuses the start without saying why.
   */
  resolveRelease: (
    organizationId: string,
    flowId: string,
  ) => Promise<FlowRelease | undefined>;
  /** Reads a committed Event intent by ID; the caller cannot supply its tenant, release or actor. */
  readCommittedStartIntent?: (intentId: string) => Promise<unknown>;
  /** Resolves the exact immutable release named by the committed intent, never the current pointer. */
  resolveCommittedStartRelease?: (
    intent: CommittedFlowStartIntent,
  ) => Promise<(FlowRelease & Readonly<{ identity: FlowReleaseIdentity }>) | undefined>;
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

/** Why a task did not run: the located, fail-closed "not yet available" outcome. */
export type FlowUnavailableNotice = Readonly<{
  taskId: string;
  taskType: string;
  code: "not_yet_available";
  /** The work that makes the task available. */
  requires: string;
}>;

export type SafeIntent = Readonly<{
  kind: FlowInterfaceIntent["kind"];
  taskId: string;
  properties: Readonly<Record<string, JsonValue>>;
}>;

export type FlowOrchestratorResponse =
  | Readonly<{
      kind: "finished";
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

export type RunAuthority =
  | Readonly<{
      kind: "person";
      session: IdentitySession;
      selection: OrganizationSelectionCandidate;
    }>
  | Readonly<{
      kind: "execution_authority";
      context: ExecutionAuthorityContext;
      organizationId: string;
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
