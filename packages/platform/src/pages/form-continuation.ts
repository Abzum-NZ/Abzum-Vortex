import "server-only";

import type { HumanOrganizationRequestResult } from "@vortex/access";
import type {
  FormContinuationOutcome,
  FormContinuationRequest,
  FormContinuationService,
  FormContinuationStartRequest,
  IdentitySession,
  OrganizationSelectionCandidate,
} from "@vortex/contracts";
import type {
  AbandonPrivateFormDraftCommand,
  PrivateFormDraftAbandonResult,
  PrivateFormDraftReadResult,
  PrivateFormDraftScope,
  ReadPrivateFormDraftCommand,
} from "./form-drafts";

/**
 * #544: the Page side of the private form continuation. Page calls the form request and
 * continuation contract through the injected `FormContinuationService` (implemented by App over the
 * flow orchestrator), so Page never imports App's implementation and every client receives the same
 * result contract.
 *
 * Page owns the private draft (#587). Before a submit it reads the person's own draft through the
 * draft service, refuses a draft whose exact id or revision is not the one the caller answered
 * from, and sends only the server-projected permitted values the draft holds; a caller never
 * supplies the answers of a draft. The draft is discarded only when the flow reports that the
 * submission is final: a partial or uncertain result keeps it for review and reconciliation.
 */

export type PrivateFormContinuationDraftPort = Readonly<{
  read: (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: ReadPrivateFormDraftCommand,
  ) => Promise<HumanOrganizationRequestResult<PrivateFormDraftReadResult>>;
  abandon: (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: AbandonPrivateFormDraftCommand,
  ) => Promise<HumanOrganizationRequestResult<PrivateFormDraftAbandonResult>>;
}>;

export type PrivateFormContinuationDependencies = Readonly<{
  continuation: FormContinuationService;
  drafts: PrivateFormContinuationDraftPort;
}>;

/** The exact draft an answer is made from; its revision must still be the current one. */
export type PrivateFormContinuationDraft = Readonly<{
  scope: PrivateFormDraftScope;
  draftId: string;
  expectedRevision: number;
}>;

type ContinuationTarget = Pick<FormContinuationRequest, "target" | "continuation" | "receipt">;

export type PrivateFormContinuationInput = ContinuationTarget &
  Readonly<{ draft: PrivateFormContinuationDraft }>;

export type PrivateFormContinuationDraftDisposition = "discarded" | "kept" | "discard_failed";

export type PrivateFormContinuationResult =
  | Readonly<{
      kind: "outcome";
      outcome: FormContinuationOutcome;
      draft: PrivateFormContinuationDraftDisposition;
    }>
  /** The draft changed since the caller read it; the answer is not sent. */
  | Readonly<{ kind: "stale_draft" }>
  /** The draft belongs to an installation, form or flow other than the paused one, or is gone. */
  | Readonly<{ kind: "draft_unavailable" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

/** The draft scope names exactly the paused form: its form and, when bound, its flow and node. */
const sameScope = (
  scope: PrivateFormDraftScope,
  target: FormContinuationRequest["target"],
): boolean =>
  target.awaiting === "form" &&
  scope.formId === target.formId &&
  (scope.flowId === undefined || scope.flowId === target.flowId) &&
  (scope.nodeId === undefined || scope.nodeId === target.nodeId);

/** The flow reported the submission final: nothing is left to review, reconcile or retry. */
const isFinalSubmission = (outcome: FormContinuationOutcome): boolean =>
  outcome.kind === "finished" &&
  (outcome.result === "committed" || outcome.result === "completed");

export const createPrivateFormContinuationAdapter = (
  dependencies: PrivateFormContinuationDependencies,
) => {
  const discard = async (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    draft: Readonly<{ draftId: string; revision: number }>,
  ): Promise<PrivateFormContinuationDraftDisposition> => {
    try {
      const abandoned = await dependencies.drafts.abandon(session, selection, {
        draftId: draft.draftId as AbandonPrivateFormDraftCommand["draftId"],
        expectedRevision: draft.revision,
      });
      return abandoned.kind === "available" && abandoned.value.outcome === "abandoned"
        ? "discarded"
        : "discard_failed";
    } catch {
      return "discard_failed";
    }
  };

  const answer = async (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    input: PrivateFormContinuationInput,
    cancel: boolean,
  ): Promise<PrivateFormContinuationResult> => {
    if (!sameScope(input.draft.scope, input.target)) return { kind: "draft_unavailable" };

    const read = await dependencies.drafts.read(session, selection, input.draft.scope);
    if (read.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
    if (read.kind !== "available" || read.value.outcome !== "available")
      return { kind: "draft_unavailable" };
    const stored = read.value.draft;
    if (stored.draftId !== input.draft.draftId) return { kind: "draft_unavailable" };
    // A draft made against another installed release never answers this one.
    if (
      stored.applicationRootId !== input.target.installation.applicationRootId ||
      stored.installationReleaseRevision !== input.target.installation.installationReleaseRevision
    )
      return { kind: "draft_unavailable" };
    if (stored.revision !== input.draft.expectedRevision) return { kind: "stale_draft" };

    const evidence = { draftId: stored.draftId, revision: stored.revision };
    const outcome = await dependencies.continuation.continue(session, selection, {
      target: input.target,
      continuation: input.continuation,
      ...(input.receipt === undefined ? {} : { receipt: input.receipt }),
      answer: cancel ? { kind: "cancel" } : { kind: "submit", values: stored.values },
      draft: evidence,
    });

    // Cancelling closes the journey; a submission discards the draft only once it is final.
    const discardDraft = cancel ? outcome.kind === "finished" : isFinalSubmission(outcome);
    return {
      kind: "outcome",
      outcome,
      draft: discardDraft ? await discard(session, selection, evidence) : "kept",
    };
  };

  return Object.freeze({
    /** Starts a flow that may show a private form. */
    request(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      request: FormContinuationStartRequest,
    ): Promise<FormContinuationOutcome> {
      return dependencies.continuation.request(session, selection, request);
    },
    /** Continues the paused form with the answers of the person's own private draft. */
    submit(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      input: PrivateFormContinuationInput,
    ): Promise<PrivateFormContinuationResult> {
      return answer(session, selection, input, false);
    },
    /**
     * Cancels the paused form. When the person has a draft for it, that draft is discarded once the
     * flow has closed; without one the cancel is sent alone.
     */
    async cancel(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      input: ContinuationTarget & Readonly<{ draft?: PrivateFormContinuationDraft }>,
    ): Promise<PrivateFormContinuationResult> {
      if (input.draft !== undefined)
        return answer(session, selection, { ...input, draft: input.draft }, true);
      const outcome = await dependencies.continuation.continue(session, selection, {
        target: input.target,
        continuation: input.continuation,
        ...(input.receipt === undefined ? {} : { receipt: input.receipt }),
        answer: { kind: "cancel" },
      });
      return { kind: "outcome", outcome, draft: "kept" };
    },
    /** Answers a confirmation the flow paused at; it involves no draft. */
    confirm(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      input: ContinuationTarget & Readonly<{ confirmed: boolean }>,
    ): Promise<FormContinuationOutcome> {
      return dependencies.continuation.continue(session, selection, {
        target: input.target,
        continuation: input.continuation,
        ...(input.receipt === undefined ? {} : { receipt: input.receipt }),
        answer: { kind: "confirm", confirmed: input.confirmed },
      });
    },
  });
};

export type PrivateFormContinuationAdapter = ReturnType<
  typeof createPrivateFormContinuationAdapter
>;
