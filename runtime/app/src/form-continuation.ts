import "server-only";

import {
  formContinuationOutcomeSchema,
  formContinuationRequestSchema,
  formContinuationStartRequestSchema,
  safeFlowResultDescriptors,
  type FormContinuationInstallation,
  type FormContinuationOutcome,
  type FormContinuationRefusalReason,
  type FormContinuationRequest,
  type FormContinuationService,
  type FormContinuationStartRequest,
  type FormContinuationTarget,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type SafeFlowResultKind,
} from "@vortex/contracts";
import type { FlowOrchestrator, FlowOrchestratorResponse } from "./flow-orchestrator";

/**
 * The App implementation of the web-independent form request and continuation contract (#544)
 * over the flow orchestrator (#579). It adds no continuation mechanism of its own: the
 * orchestrator's server-stored single-use continuation and effect ledger remain the only ones, so a
 * replayed continuation, a repeated submit or a retried resume never repeats a protected effect.
 *
 * What this layer adds is evidence validation before the orchestrator runs anything. The caller's
 * installation, release, form, flow and node, and the receipt of the run so far, are compared with
 * trusted server state and are never authority: the actor and organisation come only from the
 * verified session and selection, and the paused node and run come only from the stored run.
 */

/** What the trusted installation state says about the evidence a caller supplied. */
export type FormContinuationInstalledRelease =
  | Readonly<{ kind: "current"; releaseKey: string }>
  /** The application's active installation is no longer the one the caller saw. */
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "unavailable" }>;

export type FormContinuationInstallationResolver = (
  input: Readonly<{
    session: IdentitySession;
    selection: OrganizationSelectionCandidate;
    installation: FormContinuationInstallation;
    flowId: string;
    /** Present for a continuation: the paused node and the form it shows, which must be declared. */
    node?: Readonly<{ nodeId: string; formId?: string }>;
  }>,
) => Promise<FormContinuationInstalledRelease>;

export type FormContinuationServiceDependencies = Readonly<{
  orchestrator: Pick<FlowOrchestrator, "start" | "resume">;
  /**
   * Resolves, from the trusted active installation, the exact release of the flow set for the
   * application revision the caller names. It answers `current` only when that installation is the
   * active one for the selected organisation and, for a continuation, declares the flow, the node
   * and the form. It never reads these from the caller's evidence.
   */
  resolveInstallation: FormContinuationInstallationResolver;
}>;

const refuse = (reason: FormContinuationRefusalReason): FormContinuationOutcome => ({
  kind: "refused",
  reason,
});

/**
 * The shared safe result of a finished run. Effects that committed before a later stop are never
 * reported as a plain failure: the run is `partial`. An effect that cannot be confirmed stays
 * `uncertain`, which is never reported as success or as a clean failure.
 */
const finishedResult = (
  outcome: "committed" | "completed" | "refused" | "conflict" | "validation" | "uncertain" | "failed",
  committedEffects: number,
): SafeFlowResultKind =>
  outcome === "committed" || outcome === "completed" || outcome === "uncertain"
    ? outcome
    : committedEffects > 0
      ? "partial"
      : outcome;

const formIdOf = (
  response: Extract<FlowOrchestratorResponse, { kind: "suspended" }>,
): string | undefined => {
  const shown = response.intents.find(
    (intent) => intent.kind === "show_form" && intent.taskId === response.nodeId,
  );
  const form = shown?.properties.form;
  return typeof form === "string" ? form : undefined;
};

export const createFormContinuationService = (
  dependencies: FormContinuationServiceDependencies,
): FormContinuationService => {
  const present = (
    response: FlowOrchestratorResponse,
    context: Readonly<{
      installation: FormContinuationInstallation;
      flowId: string;
      draft?: Extract<FormContinuationOutcome, { kind: "finished" }>["draft"];
      resumed: boolean;
    }>,
  ): FormContinuationOutcome => {
    if (response.kind === "refused")
      return refuse(context.resumed ? "not_resumable" : "unavailable");

    if (response.kind === "suspended") {
      const formId = response.awaiting === "form" ? formIdOf(response) : undefined;
      const target: FormContinuationTarget = {
        installation: context.installation,
        releaseKey: response.releaseKey,
        flowId: context.flowId as FormContinuationTarget["flowId"],
        nodeId: response.nodeId,
        awaiting: response.awaiting,
        ...(formId === undefined ? {} : { formId: formId as FormContinuationTarget["formId"] }),
      };
      return {
        kind: "form_requested",
        runId: response.runId,
        receipt: { runId: response.runId, committedEffects: response.committedEffects },
        target,
        continuation: response.continuation,
        // The store may return its own timestamp text; the contract carries one ISO form.
        expiresAt: new Date(response.expiresAt).toISOString(),
        intents: [...response.intents],
        unavailable: [...response.unavailable],
      } as FormContinuationOutcome;
    }

    const result = finishedResult(response.outcome, response.committedEffects);
    return {
      kind: "finished",
      runId: response.runId,
      receipt: { runId: response.runId, committedEffects: response.committedEffects },
      result,
      presentation: safeFlowResultDescriptors[result],
      ...(response.failure === undefined ? {} : { failure: response.failure }),
      ...(response.stopped === undefined ? {} : { stopped: response.stopped }),
      outputs: { ...response.outputs },
      intents: [...response.intents],
      unavailable: [...response.unavailable],
      ...(context.draft === undefined ? {} : { draft: context.draft }),
    } as FormContinuationOutcome;
  };

  /** Every response leaves through the contract schema; anything it rejects is refused, not sent. */
  const validated = (outcome: FormContinuationOutcome): FormContinuationOutcome => {
    const parsed = formContinuationOutcomeSchema.safeParse(outcome);
    return parsed.success ? parsed.data : refuse("unavailable");
  };

  return Object.freeze({
    async request(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      candidate: FormContinuationStartRequest,
    ): Promise<FormContinuationOutcome> {
      try {
        const parsed = formContinuationStartRequestSchema.safeParse(candidate);
        if (!parsed.success) return refuse("unavailable");
        const request = parsed.data;
        const installed = await dependencies.resolveInstallation({
          session,
          selection,
          installation: request.installation,
          flowId: request.flowId,
        });
        if (installed.kind === "stale") return refuse("stale_installation");
        if (installed.kind !== "current") return refuse("unavailable");

        const response = await dependencies.orchestrator.start(
          {
            session,
            selection,
            binding: { flowId: request.flowId, inputs: request.inputs },
          },
          { releaseKey: installed.releaseKey },
        );
        return validated(
          present(response, {
            installation: request.installation,
            flowId: request.flowId,
            resumed: false,
          }),
        );
      } catch {
        return refuse("unavailable");
      }
    },

    async continue(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      candidate: FormContinuationRequest,
    ): Promise<FormContinuationOutcome> {
      try {
        const parsed = formContinuationRequestSchema.safeParse(candidate);
        if (!parsed.success) return refuse("not_resumable");
        const request = parsed.data;
        const { target } = request;

        // The installed release, flow, node and form are checked against trusted state first, so a
        // stale or forged target never reaches the continuation, which stays unspent.
        const installed = await dependencies.resolveInstallation({
          session,
          selection,
          installation: target.installation,
          flowId: target.flowId,
          node: {
            nodeId: target.nodeId,
            ...(target.formId === undefined ? {} : { formId: target.formId }),
          },
        });
        if (installed.kind === "stale") return refuse("stale_installation");
        if (installed.kind !== "current") return refuse("unavailable");
        if (installed.releaseKey !== target.releaseKey) return refuse("stale_installation");

        const answer = request.answer;
        const response = await dependencies.orchestrator.resume(
          {
            session,
            selection,
            flowId: target.flowId,
            continuation: request.continuation,
            answer:
              answer.kind === "confirm"
                ? { kind: "confirmed", confirmed: answer.confirmed }
                : answer.kind === "cancel"
                  ? { kind: "form_answered", submitted: false, values: null }
                  : { kind: "form_answered", submitted: true, values: answer.values },
          },
          {
            releaseKey: installed.releaseKey,
            pausedAt: { nodeId: target.nodeId, awaiting: target.awaiting },
            ...(request.receipt === undefined ? {} : { receipt: request.receipt }),
          },
        );
        return validated(
          present(response, {
            installation: target.installation,
            flowId: target.flowId,
            ...(request.draft === undefined ? {} : { draft: request.draft }),
            resumed: true,
          }),
        );
      } catch {
        return refuse("unavailable");
      }
    },
  });
};
