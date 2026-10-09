import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  formContinuationReceiptSchema,
  formContinuationTargetSchema,
  flowRefusalFeedbackSchema,
  flowSchema,
  flowTaskChildLists,
  flowBindingInvocationSchema,
  FORM_CONTAINER_BLOCK_RELEASE,
  identitySessionSchema,
  organizationSelectionCandidateSchema,
  PLATFORM_BLOCK_RELEASES,
  safeFlowResultDescriptors,
  recordIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  type ComponentFlowBinding,
  type FormContinuationOutcome,
  type FormContinuationReceipt,
  type FormContinuationRequest,
  type FormContinuationTarget,
  type ApplicationContentV2,
  type ModuleDefinitionConsumerReadResultV3,
  type FlowBindingInvocation,
  type FlowDefinition,
  type FlowRefusalFeedback,
  type FlowTask,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
  type SafeFlowResultDescriptor,
} from "@vortex/contracts";
import type {
  FlowNamedAction,
  FlowOrchestrator,
  FlowOrchestratorResponse,
  FlowRecordType,
  FlowRelease,
  FlowRunExpectation,
  FlowSubject,
  FlowUnavailableNotice,
} from "@vortex/app";

/**
 * The one server entry point that runs the flow bound to a component event (architecture decision
 * 1, "Who starts a flow"). Web controls, MCP tools and interface operations all call it, so a
 * button, menu command or row action is never wired straight to an operation.
 *
 * A request is one of two things and nothing else:
 * - a **binding** invocation: the exact installation revision, release, binding and flow identity
 *   the surface was rendered from, one click identity, and the values the surface itself supplies;
 * - a **continuation**: the token a suspended run handed out, with the person's answer.
 *
 * What it guarantees:
 * - The organisation, installation and every binding come from the trusted installation reader for
 *   the initiator's own selection, never from the request. A binding that is not in the active
 *   installation revision, names another flow, or whose release differs is refused with the one
 *   neutral result an unknown identity gets, so a caller learns nothing about what exists.
 * - A request rendered from an older installation revision returns `reload`, so the surface
 *   refreshes instead of running a flow the installation no longer holds. The check happens only
 *   after the initiator's own installation was read, so it discloses nothing to a stranger.
 * - The flow's inputs are the binding's own: its literals, plus the caller inputs it declares,
 *   filled by name from the values the surface supplies. A surface can neither add an input the
 *   binding does not declare nor override one the binding fixes. Inputs that need page data
 *   (references and formulas) are not evaluated on the server and fail closed, except for the one
 *   declared `record.read_fields` input, whose exact selected-record tuple is checked against the
 *   installed projection and reduced to its record ID before Flow receives it.
 * - One click runs the flow once. The run identity is derived from the initiator, organisation,
 *   binding and click identity, so a repeated request for the same click reaches the same run and
 *   the effect ledger replays its recorded outcome instead of repeating an effect.
 * - The surface may name the record it was rendered for, with the revision it showed. That subject
 *   is evidence for the run's record tasks and named actions, never authority: the protected record
 *   paths decide access, record type and revision for it themselves.
 * - The orchestrator does the running. This module never executes a task itself and never throws.
 */

const maximumSuppliedCharacters = 65_536;

/**
 * What the trusted installation read holds for one organisation's active installation: its
 * revision, the exact release the flows were compiled in, and that release's bindings and flows.
 * It is produced only by the protected active-installation and Definition reads for the
 * initiator's own selection.
 */
export type InstalledFlowBindings = Readonly<{
  organizationId: string;
  applicationRootId: string;
  installationRevision: number;
  /** Identifies the exact release, so a continuation only resumes against the flows it started with. */
  releaseKey: string;
  bindings: readonly ComponentFlowBinding[];
  flows: ReadonlyMap<string, unknown>;
  /** The release's record types, for the values of a Save record task. */
  recordTypes?: ReadonlyMap<string, FlowRecordType>;
  /** The release's named actions by key, for a Call protected operation task that names one. */
  namedActions?: ReadonlyMap<string, FlowNamedAction>;
  /** The exact active Application and Module definitions used to verify authored form values. */
  applicationContent?: ApplicationContentV2;
  modules?: readonly ModuleDefinitionConsumerReadResultV3[];
  /** Compiler-owned selected-record projections derived from the exact installed releases. */
  selectedRecordReadProjections?: FlowRelease["selectedRecordReadProjections"];
  /** Flow input name to exact selected record type, keyed by lower-case flow identity. */
  selectedRecordReadInputs?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Exact installed Module owner for each selected-read record type, keyed by lower-case ID. */
  selectedRecordReadModules?: ReadonlyMap<
    string,
    Readonly<{ moduleRootId: string; moduleReleaseRevision: number; storageContractId: string }>
  >;
}>;

export type FlowBindingEndpointDependencies = Readonly<{
  /** Reads the active installation for the initiator's selection; `undefined` refuses neutrally. */
  readInstallation: (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
  ) => Promise<InstalledFlowBindings | undefined>;
  /**
   * The orchestrator bound to exactly this release. `runId` is set for a binding start so a
   * repeated click reuses one run identity; it is absent for a continuation.
   */
  orchestratorFor: (
    release: FlowRelease,
    runId: string | undefined,
    installation: InstalledFlowBindings,
  ) => Pick<FlowOrchestrator, "start" | "resume">;
  /**
   * THE SEAM for #588's form-submit adapter (`createPrivateFormSubmitAdapter`): turns what a form
   * submission supplies, and the record the form was rendered for, into the caller inputs of a
   * `form_submit` binding. Until it is supplied a `form_submit` binding is refused, so there is
   * never a second, ad hoc submit path.
   */
  adaptFormSubmit?: (
    binding: ComponentFlowBinding,
    callerInputs: Readonly<Record<string, unknown>>,
    subject: FlowSubject | undefined,
    installation: InstalledFlowBindings,
  ) => Promise<
    | Readonly<{
        callerInputs: Readonly<Record<string, unknown>>;
        recoverySubject?: Readonly<{ recordTypeId: string; recordId: string; revision: number }>;
      }>
    | undefined
  >;
  /**
   * THE SEAM for #588's continuation adapter: forwards an exact paused target and its run receipt to
   * the web-independent form continuation interface (#544), which compares them with trusted state.
   * Until it is supplied a continuation that carries a target is refused.
   */
  continueForm?: (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    request: FormContinuationRequest,
  ) => Promise<FormContinuationOutcome>;
}>;

type SafeIntents = Extract<FlowOrchestratorResponse, { intents: unknown }>["intents"];

export type FlowBindingEndpointResult =
  /** The request named a stale installation revision: reload the page, nothing was run. */
  | Readonly<{ kind: "reload"; installationRevision: number }>
  /** The run ended. `descriptor` is the shared safe result; `outputs` only when it says available. */
  | Readonly<{
      kind: "result";
      runId: string;
      descriptor: SafeFlowResultDescriptor;
      outputs: Readonly<Record<string, JsonValue>>;
      /** Browser intents such as navigation or a message, for the surface to carry out. */
      intents: SafeIntents;
      unavailable: readonly FlowUnavailableNotice[];
      failure?: Readonly<{
        code: string;
        taskId?: string;
        diagnostic?: FlowRefusalFeedback;
      }>;
    }>
  /** The run waits for the person: a form or confirmation intent and the single-use continuation. */
  | Readonly<{
      kind: "intent";
      runId: string;
      awaiting: "form" | "confirm";
      intents: SafeIntents;
      continuation: string;
      expiresAt: string;
      /** The exact paused target and receipt the surface returns with the continuation (evidence). */
      target?: FormContinuationTarget;
      receipt?: FormContinuationReceipt;
      unavailable: readonly FlowUnavailableNotice[];
    }>
  /** Unknown, not installed, foreign, expired or not permitted: one neutral result. */
  | Readonly<{ kind: "refused" }>;

const refused: FlowBindingEndpointResult = Object.freeze({ kind: "refused" });

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
  typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);

const isPlacementProvenVisible = (placement: Record<string, unknown>): boolean => {
  if (
    placement.visibilityCondition !== undefined ||
    placement.viewPermissionKey !== undefined ||
    placement.usePermissionKey !== undefined ||
    !isRecord(placement.responsive)
  )
    return false;
  const responsive = placement.responsive;
  return ["desktop", "tablet", "phone"].every((breakpoint) => {
    const layout = responsive[breakpoint];
    return isRecord(layout) && layout.visible === true;
  });
};

/** A field can be named only when this exact binding control owns one current visible form field. */
const hasVisibleOwningFormField = (
  installation: InstalledFlowBindings,
  controlId: string,
  callerInputName: string,
): boolean => {
  const pages = installation.applicationContent?.pages;
  if (!Array.isArray(pages)) return false;

  const controls: { formId: string | undefined; visible: boolean }[] = [];
  const fields: { formId: string; visible: boolean }[] = [];
  const inputReleases = PLATFORM_BLOCK_RELEASES.filter((release) =>
    release.supportedEvents.includes("field_changed"),
  );
  const visitSlotTree = (
    candidate: unknown,
    currentFormId?: string,
    ancestorsVisible = true,
  ): void => {
    if (!isRecord(candidate)) return;
    if (!isRecord(candidate.placements)) {
      for (const child of Object.values(candidate)) visitSlotTree(child, currentFormId, ancestorsVisible);
      return;
    }
    for (const [placementId, value] of Object.entries(candidate.placements)) {
      if (!isRecord(value)) continue;
      const block = value.block;
      const blockIsForm =
        isRecord(block) &&
        typeof block.blockId === "string" &&
        typeof block.releaseVersion === "string" &&
        sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId) &&
        block.releaseVersion === FORM_CONTAINER_BLOCK_RELEASE.releaseVersion;
      const formId = blockIsForm ? placementId : currentFormId;
      const visible = ancestorsVisible && isPlacementProvenVisible(value);
      if (sameId(placementId, controlId)) controls.push({ formId, visible });

      if (
        formId !== undefined &&
        isRecord(block) &&
        typeof block.blockId === "string" &&
        typeof block.releaseVersion === "string" &&
        isRecord(value.settings)
      ) {
        const blockId = block.blockId;
        const releaseVersion = block.releaseVersion;
        const registeredInput = inputReleases.some(
          (release) =>
            sameId(release.blockId, blockId) && release.releaseVersion === releaseVersion,
        );
        const name = value.settings.name;
        if (
          registeredInput &&
          isRecord(name) &&
          name.kind === "text" &&
          name.value === callerInputName
        )
          fields.push({ formId, visible });
      }

      if (isRecord(value.slots))
        for (const child of Object.values(value.slots)) visitSlotTree(child, formId, visible);
    }
  };

  for (const page of pages) {
    if (!isRecord(page) || !isRecord(page.composition)) continue;
    const composition = page.composition;
    if ("main" in composition) visitSlotTree(composition.main);
    if ("content" in composition) visitSlotTree(composition.content);
    if ("stepContent" in composition) visitSlotTree(composition.stepContent);
  }

  if (
    controls.length !== 1 ||
    !controls[0]!.visible ||
    controls[0]!.formId === undefined ||
    !sameId(controls[0]!.formId, controlId)
  )
    return false;
  const ownerFormId = controls[0]!.formId;
  const matchingFields = fields.filter(
    (field) => field.formId === ownerFormId && field.visible,
  );
  return matchingFields.length === 1;
};

const directFlowInputName = (candidate: unknown): string | undefined => {
  if (
    !isRecord(candidate) ||
    candidate.kind !== "reference" ||
    !isRecord(candidate.reference) ||
    candidate.reference.source !== "input" ||
    typeof candidate.reference.name !== "string" ||
    candidate.reference.path !== undefined
  )
    return undefined;
  return candidate.reference.name;
};

const operationInputFlowInput = (
  flow: FlowDefinition,
  taskId: string,
  operationInput: string,
): string | undefined => {
  const matches: FlowTask[] = [];
  const visit = (tasks: readonly FlowTask[]): void => {
    for (const task of tasks) {
      if (task.id === taskId) matches.push(task);
      for (const child of flowTaskChildLists(task)) visit(child.tasks);
    }
  };
  visit(flow.tasks);
  visit(flow.errors);
  visit(flow.finally);
  if (matches.length !== 1 || matches[0]!.type !== "operation.call") return undefined;

  const matchedTask = matches[0]!;
  if (!isRecord(matchedTask.properties)) return undefined;
  const properties = matchedTask.properties;
  const taskInputs = properties.inputs;
  if (taskInputs === undefined)
    return Object.hasOwn(flow.inputs, operationInput) ? operationInput : undefined;
  if (!isRecord(taskInputs) || taskInputs.kind !== "map" || !isRecord(taskInputs.entries))
    return undefined;
  const flowInputName = directFlowInputName(taskInputs.entries[operationInput]);
  return flowInputName !== undefined && Object.hasOwn(flow.inputs, flowInputName)
    ? flowInputName
    : undefined;
};

const submittedFieldForDiagnostic = (
  diagnostic: FlowRefusalFeedback,
  taskId: string | undefined,
  flowId: string,
  binding: ComponentFlowBinding | undefined,
  installation: InstalledFlowBindings,
): string | undefined => {
  const operationInput = diagnostic.operationInput;
  if (
    diagnostic.code !== "invalid_command" ||
    operationInput === undefined ||
    taskId === undefined ||
    binding === undefined ||
    binding.event !== "form_submit" ||
    !sameId(binding.flow.flowId, flowId)
  )
    return undefined;
  const rawFlow = installation.flows.get(flowId);
  const parsedFlow = flowSchema.safeParse(rawFlow);
  if (!parsedFlow.success) return undefined;
  const flowInputName = operationInputFlowInput(parsedFlow.data, taskId, operationInput);
  if (flowInputName === undefined) return undefined;
  const bindingInput = binding.flow.inputs[flowInputName];
  if (
    !isRecord(bindingInput) ||
    bindingInput.kind !== "caller" ||
    typeof bindingInput.name !== "string" ||
    // The private form adapter supplies these from the whole answer, selection or page subject,
    // so a same-named registered field does not prove this value came from that field.
    ["values", "selected_owner_group_id", "record"].includes(bindingInput.name)
  )
    return undefined;
  return hasVisibleOwningFormField(installation, binding.controlId, bindingInput.name)
    ? bindingInput.name
    : undefined;
};

const surfaceDiagnostic = (
  diagnostic: FlowRefusalFeedback | undefined,
  taskId: string | undefined,
  flowId: string,
  binding: ComponentFlowBinding | undefined,
  installation: InstalledFlowBindings,
): FlowRefusalFeedback | undefined => {
  if (diagnostic === undefined) return undefined;
  const parsed = flowRefusalFeedbackSchema.safeParse(diagnostic);
  if (!parsed.success) return undefined;
  const submittedField = submittedFieldForDiagnostic(
    parsed.data,
    taskId,
    flowId,
    binding,
    installation,
  );
  return flowRefusalFeedbackSchema.parse({
    code: parsed.data.code,
    ...(submittedField === undefined ? {} : { submittedField }),
  });
};

const selectedRecordInputSchema = z
  .object({ recordTypeId: recordTypeIdSchema, recordId: recordIdSchema })
  .strict();

const withinSupplied = (candidate: unknown): boolean => {
  try {
    return (JSON.stringify(candidate) ?? "").length <= maximumSuppliedCharacters;
  } catch {
    return false;
  }
};

/**
 * A stable run identity for one click. Version and variant bits are set so it is a strictly valid
 * UUID everywhere the run id is checked.
 */
const runIdForClick = (
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  bindingId: string,
  installationRevision: number,
  clickId: string,
): string => {
  const bytes = createHash("sha256")
    .update(
      [
        session.identityId,
        selection.organizationId,
        bindingId,
        String(installationRevision),
        clickId,
      ]
        .map((part) => part.toLowerCase())
        .join("|"),
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * The flow's input values for a binding: the binding's literals and the caller inputs it declares.
 * `undefined` when an input cannot be filled, so the click is refused instead of run half-filled.
 */
const bindingInputs = (
  binding: ComponentFlowBinding,
  callerInputs: Readonly<Record<string, unknown>>,
  selectedRecordReadInputs: ReadonlyMap<string, string>,
): Record<string, unknown> | undefined => {
  const inputs: Record<string, unknown> = {};
  const declaredCallerNames = new Set<string>();
  for (const inputName of selectedRecordReadInputs.keys()) {
    const bindingInput = binding.flow.inputs[inputName];
    if (typeof bindingInput !== "object" || bindingInput === null || bindingInput.kind !== "caller")
      continue;
    const matchingInputNames = Object.values(binding.flow.inputs).filter(
      (candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        candidate.kind === "caller" &&
        candidate.name === bindingInput.name,
    );
    if (matchingInputNames.length !== 1) return undefined;
  }
  for (const [name, value] of Object.entries(binding.flow.inputs)) {
    if (typeof value !== "object" || value === null) return undefined;
    if (value.kind === "literal") inputs[name] = value.literal.value;
    else if (value.kind === "caller") {
      declaredCallerNames.add(value.name);
      if (!Object.hasOwn(callerInputs, value.name)) return undefined;
      const selectedRecordTypeId = selectedRecordReadInputs.get(name);
      if (selectedRecordTypeId === undefined) inputs[name] = callerInputs[value.name];
      else {
        const selectedRecord = selectedRecordInputSchema.safeParse(callerInputs[value.name]);
        if (
          !selectedRecord.success ||
          !sameId(selectedRecord.data.recordTypeId, selectedRecordTypeId)
        )
          return undefined;
        // The type is checked against the installed task declaration above; only the record ID
        // enters Flow's ordinary typed input map.
        inputs[name] = selectedRecord.data.recordId;
      }
    } else return undefined;
  }
  // A surface may only fill the caller inputs the binding declares.
  for (const name of Object.keys(callerInputs))
    if (!declaredCallerNames.has(name)) return undefined;
  return inputs;
};

const finishedResult = (
  response: Extract<FlowOrchestratorResponse, { kind: "finished" }>,
  context: Readonly<{
    flowId: string;
    binding?: ComponentFlowBinding;
    installation: InstalledFlowBindings;
  }>,
): FlowBindingEndpointResult => {
  // Only committed changes contribute to this count, so a successful read step cannot turn a
  // later refusal into a false `partial` result. An uncertain effect stays `uncertain`.
  const outcome =
    response.outcome === "committed" ||
    response.outcome === "completed" ||
    response.outcome === "uncertain" ||
    response.committedEffects === 0
      ? response.outcome
      : "partial";
  const descriptor = safeFlowResultDescriptors[outcome];
  const diagnostic =
    response.failure === undefined
      ? undefined
      : surfaceDiagnostic(
          response.failure.diagnostic,
          response.failure.taskId,
          context.flowId,
          context.binding,
          context.installation,
        );
  return {
    kind: "result",
    runId: response.runId,
    descriptor,
    outputs: descriptor.outputs === "available" ? response.outputs : {},
    intents: response.intents,
    unavailable: response.unavailable,
    ...(response.failure === undefined
      ? {}
      : {
          failure: {
            code: response.failure.code,
            ...(response.failure.taskId === undefined
              ? {}
              : { taskId: response.failure.taskId }),
            ...(diagnostic === undefined ? {} : { diagnostic }),
          },
        }),
  };
};

/** The form a suspended show_form task names, when it declares one. */
const formIdOf = (
  response: Extract<FlowOrchestratorResponse, { kind: "suspended" }>,
): string | undefined => {
  const shown = response.intents.find(
    (intent) => intent.kind === "show_form" && intent.taskId === response.nodeId,
  );
  const form = shown?.properties.form;
  return typeof form === "string" ? form : undefined;
};

/**
 * The exact paused target the surface returns with its continuation. It is built from the trusted
 * installation and the server-stored run, never from the request, and only when it satisfies the
 * shared #544 target contract; otherwise the surface resumes under the server's own receipt checks.
 */
const suspendedTarget = (
  response: Extract<FlowOrchestratorResponse, { kind: "suspended" }>,
  context: Readonly<{ applicationRootId: string; installationRevision: number; flowId: string }>,
): FormContinuationTarget | undefined => {
  const formId = response.awaiting === "form" ? formIdOf(response) : undefined;
  const parsed = formContinuationTargetSchema.safeParse({
    installation: {
      applicationRootId: context.applicationRootId,
      installationReleaseRevision: context.installationRevision,
    },
    releaseKey: response.releaseKey,
    flowId: context.flowId,
    nodeId: response.nodeId,
    awaiting: response.awaiting,
    ...(formId === undefined ? {} : { formId }),
  });
  return parsed.success ? parsed.data : undefined;
};

const toResult = (
  response: FlowOrchestratorResponse,
  context: Readonly<{
    applicationRootId: string;
    installationRevision: number;
    flowId: string;
    binding?: ComponentFlowBinding;
    installation: InstalledFlowBindings;
  }>,
): FlowBindingEndpointResult => {
  switch (response.kind) {
    case "finished":
      return finishedResult(response, context);
    case "suspended": {
      const target = suspendedTarget(response, context);
      const receipt = formContinuationReceiptSchema.safeParse({
        runId: response.runId,
        committedEffects: response.committedEffects,
      });
      return {
        kind: "intent",
        runId: response.runId,
        awaiting: response.awaiting,
        intents: response.intents,
        continuation: response.continuation,
        expiresAt: response.expiresAt,
        ...(target === undefined ? {} : { target }),
        ...(receipt.success ? { receipt: receipt.data } : {}),
        unavailable: response.unavailable,
      };
    }
    default:
      return refused;
  }
};

/** Maps the #544 continuation outcome back onto this endpoint's one result contract. */
const continuationResult = (
  outcome: FormContinuationOutcome,
  installationRevision: number,
  context: Readonly<{
    flowId: string;
    binding?: ComponentFlowBinding;
    installation: InstalledFlowBindings;
  }>,
): FlowBindingEndpointResult => {
  switch (outcome.kind) {
    case "finished": {
      const diagnostic = surfaceDiagnostic(
        outcome.failure?.diagnostic,
        outcome.failure?.taskId,
        context.flowId,
        context.binding,
        context.installation,
      );
      return {
        kind: "result",
        runId: outcome.runId,
        descriptor: outcome.presentation,
        outputs: outcome.presentation.outputs === "available" ? outcome.outputs : {},
        intents: outcome.intents as SafeIntents,
        unavailable: outcome.unavailable,
        ...(outcome.failure === undefined
          ? {}
          : {
              failure: {
                code: outcome.failure.code,
                ...(outcome.failure.taskId === undefined
                  ? {}
                  : { taskId: outcome.failure.taskId }),
                ...(diagnostic === undefined ? {} : { diagnostic }),
              },
            }),
      };
    }
    case "form_requested":
      return {
        kind: "intent",
        runId: outcome.runId,
        awaiting: outcome.target.awaiting,
        intents: outcome.intents as SafeIntents,
        continuation: outcome.continuation,
        expiresAt: outcome.expiresAt,
        target: outcome.target,
        receipt: outcome.receipt,
        unavailable: outcome.unavailable,
      };
    default:
      return outcome.reason === "stale_installation"
        ? { kind: "reload", installationRevision }
        : refused;
  }
};

export const createFlowBindingEndpoint = (dependencies: FlowBindingEndpointDependencies) =>
  Object.freeze({
    /**
     * Runs the flow bound to one component event, or resumes a suspended run, for the verified
     * initiator and the organisation that person selected. It never throws: every failure is the
     * neutral refusal or a safe result.
     */
    async invoke(
      sessionCandidate: IdentitySession,
      selectionCandidate: OrganizationSelectionCandidate,
      invocationCandidate: FlowBindingInvocation,
    ): Promise<FlowBindingEndpointResult> {
      try {
        const session = identitySessionSchema.safeParse(sessionCandidate);
        const selection = organizationSelectionCandidateSchema.safeParse(selectionCandidate);
        const invocation = flowBindingInvocationSchema.safeParse(invocationCandidate);
        if (!session.success || !selection.success || !invocation.success) return refused;
        const request = invocation.data;
        if (!withinSupplied(request.kind === "binding" ? request.callerInputs : request.answer))
          return refused;

        const installation = await dependencies.readInstallation(session.data, selection.data);
        if (
          installation === undefined ||
          !sameId(installation.organizationId, selection.data.organizationId)
        )
          return refused;
        if (request.installationRevision !== installation.installationRevision)
          return { kind: "reload", installationRevision: installation.installationRevision };
        if (request.releaseKey !== installation.releaseKey) return refused;

        const release: FlowRelease = {
          releaseKey: installation.releaseKey,
          flows: installation.flows,
          ...(installation.recordTypes === undefined
            ? {}
            : { recordTypes: installation.recordTypes }),
          ...(installation.namedActions === undefined
            ? {}
            : { namedActions: installation.namedActions }),
          ...(installation.selectedRecordReadProjections === undefined
            ? {}
            : { selectedRecordReadProjections: installation.selectedRecordReadProjections }),
        };

        if (request.kind === "continuation") {
          // A continuation resumes only a flow the active installation still binds: a run started
          // from a binding that a newer installation withdrew is not resumed.
          if (!installation.bindings.some((entry) => sameId(entry.flow.flowId, request.flowId)))
            return refused;
          const target = request.target;
          // #588: an exact paused target always goes to the #544 interface, the one place that
          // compares the installation, release, flow, node, form and receipt with trusted state; a
          // stale target comes back as a reload and a forged one as the neutral refusal.
          if (target !== undefined) {
            if (dependencies.continueForm === undefined || !sameId(target.flowId, request.flowId))
              return refused;
            const outcome = await dependencies.continueForm(session.data, selection.data, {
              target,
              continuation: request.continuation,
              answer: request.answer,
              ...(request.receipt === undefined ? {} : { receipt: request.receipt }),
            });
            return continuationResult(outcome, installation.installationRevision, {
              flowId: request.flowId,
              installation,
            });
          }
          // A form answer must pass through the paused-target adapter, which resolves every
          // reference-choice key before the flow sees the submitted values.
          if (request.answer.kind === "submit") return refused;
          const expectation: FlowRunExpectation = {
            releaseKey: installation.releaseKey,
            ...(request.receipt === undefined ? {} : { receipt: request.receipt }),
          };
          const response = await dependencies
            .orchestratorFor(release, undefined, installation)
            .resume(
              {
                session: session.data,
                selection: selection.data,
                flowId: request.flowId,
                continuation: request.continuation,
                answer: request.answer,
              },
              expectation,
            );
          return toResult(response, {
            applicationRootId: installation.applicationRootId,
            installationRevision: installation.installationRevision,
            flowId: request.flowId,
            installation,
          });
        }

        const matchingBindings = installation.bindings.filter((entry) =>
          sameId(entry.bindingId, request.bindingId),
        );
        if (
          matchingBindings.length !== 1 ||
          !sameId(matchingBindings[0]!.flow.flowId, request.flowId)
        )
          return refused;
        const binding = matchingBindings[0]!;

        let callerInputs: Readonly<Record<string, unknown>> = request.callerInputs;
        let recoverySubject:
          | Readonly<{ recordTypeId: string; recordId: string; revision: number }>
          | undefined;
        if (binding.event === "form_submit") {
          const adapted = await dependencies.adaptFormSubmit?.(
            binding,
            callerInputs,
            request.subject,
            installation,
          );
          if (adapted === undefined || !isRecord(adapted.callerInputs)) return refused;
          callerInputs = adapted.callerInputs;
          if (adapted.recoverySubject !== undefined) {
            const parsedRecoverySubject = z
              .object({
                recordTypeId: recordTypeIdSchema,
                recordId: recordIdSchema,
                revision: revisionSchema.max(Number.MAX_SAFE_INTEGER - 1),
              })
              .strict()
              .safeParse(adapted.recoverySubject);
            if (
              !parsedRecoverySubject.success ||
              request.subject === undefined ||
              !sameId(parsedRecoverySubject.data.recordId, request.subject.recordId) ||
              parsedRecoverySubject.data.revision !== request.subject.revision
            )
              return refused;
            recoverySubject = parsedRecoverySubject.data;
          }
        }
        const selectedRecordReadInputs =
          installation.selectedRecordReadInputs?.get(String(binding.flow.flowId).toLowerCase()) ??
          new Map<string, string>();
        const inputs = bindingInputs(binding, callerInputs, selectedRecordReadInputs);
        if (inputs === undefined) return refused;

        const runId = runIdForClick(
          session.data,
          selection.data,
          binding.bindingId,
          installation.installationRevision,
          request.clickId,
        );
        const response = await dependencies.orchestratorFor(release, runId, installation).start({
          session: session.data,
          selection: selection.data,
          binding: { flowId: binding.flow.flowId, inputs },
          ...(request.subject === undefined ? {} : { subject: request.subject }),
          ...(recoverySubject === undefined ? {} : { recoverySubject }),
        });
        return toResult(response, {
          applicationRootId: installation.applicationRootId,
          installationRevision: installation.installationRevision,
          flowId: binding.flow.flowId,
          binding,
          installation,
        });
      } catch {
        return refused;
      }
    },
  });

export type FlowBindingEndpoint = ReturnType<typeof createFlowBindingEndpoint>;
