import "server-only";

import { createHash } from "node:crypto";
import {
  containedComponentIdSchema,
  flowIdSchema,
  formContinuationReceiptSchema,
  formContinuationTargetSchema,
  identitySessionSchema,
  organizationSelectionCandidateSchema,
  safeFlowResultDescriptors,
  type ComponentFlowBinding,
  type FormContinuationOutcome,
  type FormContinuationReceipt,
  type FormContinuationRequest,
  type FormContinuationTarget,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
  type SafeFlowResultDescriptor,
} from "@vortex/contracts";
import type {
  FlowOrchestrator,
  FlowOrchestratorResponse,
  FlowRelease,
  FlowRunExpectation,
  FlowUnavailableNotice,
} from "@vortex/app";
import { z } from "zod";

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
 *   (references and formulas) are not evaluated on the server and fail closed.
 * - One click runs the flow once. The run identity is derived from the initiator, organisation,
 *   binding and click identity, so a repeated request for the same click reaches the same run and
 *   the effect ledger replays its recorded outcome instead of repeating an effect.
 * - The orchestrator does the running. This module never executes a task itself and never throws.
 */

const maximumSuppliedCharacters = 65_536;

const installationRevisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const releaseKeySchema = z.string().min(1).max(200);

const bindingInvocationSchema = z
  .object({
    kind: z.literal("binding"),
    installationRevision: installationRevisionSchema,
    releaseKey: releaseKeySchema,
    bindingId: containedComponentIdSchema,
    flowId: flowIdSchema,
    /** One identity per user gesture, so a repeated request for the same click is the same run. */
    clickId: z.uuid(),
    /** The values the surface itself supplies, by the name of the binding's `caller` input. */
    callerInputs: z.record(z.string().min(1).max(100), z.unknown()).default({}),
  })
  .strict();

const continuationInvocationSchema = z
  .object({
    kind: z.literal("continuation"),
    installationRevision: installationRevisionSchema,
    releaseKey: releaseKeySchema,
    flowId: flowIdSchema,
    continuation: z.string().min(16).max(128),
    answer: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("form_answered"),
          submitted: z.boolean(),
          values: z.unknown(),
        })
        .strict(),
      z.object({ kind: z.literal("confirmed"), confirmed: z.boolean() }).strict(),
    ]),
    /**
     * #588: the exact paused target and the run receipt the surface last saw. Both are evidence: the
     * server compares them with the trusted installation and the stored run, so a caller can neither
     * skip unanswered inputs nor name a different node. The target is absent only for a pause the
     * server issued none for (a form node that names no form); that resume stays under the
     * orchestrator's own release and receipt checks. No private draft evidence is accepted: until a
     * draft authority can verify one on the server, a request that names a draft is refused.
     */
    target: formContinuationTargetSchema.optional(),
    receipt: formContinuationReceiptSchema.optional(),
  })
  .strict();

export const flowBindingInvocationSchema = z.discriminatedUnion("kind", [
  bindingInvocationSchema,
  continuationInvocationSchema,
]);

export type FlowBindingInvocation = z.input<typeof flowBindingInvocationSchema>;

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
  ) => Pick<FlowOrchestrator, "start" | "resume">;
  /**
   * THE SEAM for #588's form-submit adapter (`createPrivateFormSubmitAdapter`): turns what a form
   * submission supplies into the caller inputs of a `form_submit` binding. Until it is supplied a
   * `form_submit` binding is refused, so there is never a second, ad hoc submit path.
   */
  adaptFormSubmit?: (
    binding: ComponentFlowBinding,
    callerInputs: Readonly<Record<string, unknown>>,
  ) => Promise<Readonly<Record<string, unknown>> | undefined>;
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
      failure?: Readonly<{ code: string; taskId?: string }>;
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
): Record<string, unknown> | undefined => {
  const inputs: Record<string, unknown> = {};
  const declaredCallerNames = new Set<string>();
  for (const [name, value] of Object.entries(binding.flow.inputs)) {
    if (typeof value !== "object" || value === null) return undefined;
    if (value.kind === "literal") inputs[name] = value.literal.value;
    else if (value.kind === "caller") {
      declaredCallerNames.add(value.name);
      if (!Object.hasOwn(callerInputs, value.name)) return undefined;
      inputs[name] = callerInputs[value.name];
    } else return undefined;
  }
  // A surface may only fill the caller inputs the binding declares.
  for (const name of Object.keys(callerInputs)) if (!declaredCallerNames.has(name)) return undefined;
  return inputs;
};

const finishedResult = (
  response: Extract<FlowOrchestratorResponse, { kind: "finished" }>,
): FlowBindingEndpointResult => {
  // Effects that committed before a later stop are never reported as a plain failure: the run is
  // `partial`. An uncertain effect stays `uncertain` (the same mapping as the form continuation).
  const outcome =
    response.outcome === "committed" ||
    response.outcome === "completed" ||
    response.outcome === "uncertain" ||
    response.committedEffects === 0
      ? response.outcome
      : "partial";
  const descriptor = safeFlowResultDescriptors[outcome];
  return {
    kind: "result",
    runId: response.runId,
    descriptor,
    outputs: descriptor.outputs === "available" ? response.outputs : {},
    intents: response.intents,
    unavailable: response.unavailable,
    ...(response.failure === undefined ? {} : { failure: response.failure }),
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
  context: Readonly<{ applicationRootId: string; installationRevision: number; flowId: string }>,
): FlowBindingEndpointResult => {
  switch (response.kind) {
    case "finished":
      return finishedResult(response);
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
): FlowBindingEndpointResult => {
  switch (outcome.kind) {
    case "finished":
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
                ...(outcome.failure.taskId === undefined ? {} : { taskId: outcome.failure.taskId }),
              },
            }),
      };
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
        if (
          !withinSupplied(request.kind === "binding" ? request.callerInputs : request.answer)
        )
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
            const answer =
              request.answer.kind === "confirmed"
                ? ({ kind: "confirm", confirmed: request.answer.confirmed } as const)
                : request.answer.submitted
                  ? ({
                      kind: "submit",
                      values: request.answer.values as Record<string, JsonValue>,
                    } as const)
                  : ({ kind: "cancel" } as const);
            const outcome = await dependencies.continueForm(session.data, selection.data, {
              target,
              continuation: request.continuation,
              answer,
              ...(request.receipt === undefined ? {} : { receipt: request.receipt }),
            });
            return continuationResult(outcome, installation.installationRevision);
          }
          const expectation: FlowRunExpectation = {
            releaseKey: installation.releaseKey,
            ...(request.receipt === undefined ? {} : { receipt: request.receipt }),
          };
          const response = await dependencies
            .orchestratorFor(release, undefined)
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
          });
        }

        const binding = installation.bindings.find((entry) =>
          sameId(entry.bindingId, request.bindingId),
        );
        if (binding === undefined || !sameId(binding.flow.flowId, request.flowId)) return refused;

        let callerInputs: Readonly<Record<string, unknown>> = request.callerInputs;
        if (binding.event === "form_submit") {
          const adapted = await dependencies.adaptFormSubmit?.(binding, callerInputs);
          if (adapted === undefined || !isRecord(adapted)) return refused;
          callerInputs = adapted;
        }
        const inputs = bindingInputs(binding, callerInputs);
        if (inputs === undefined) return refused;

        const runId = runIdForClick(
          session.data,
          selection.data,
          binding.bindingId,
          installation.installationRevision,
          request.clickId,
        );
        const response = await dependencies.orchestratorFor(release, runId).start({
          session: session.data,
          selection: selection.data,
          binding: { flowId: binding.flow.flowId, inputs },
        });
        return toResult(response, {
          applicationRootId: installation.applicationRootId,
          installationRevision: installation.installationRevision,
          flowId: binding.flow.flowId,
        });
      } catch {
        return refused;
      }
    },
  });

export type FlowBindingEndpoint = ReturnType<typeof createFlowBindingEndpoint>;
