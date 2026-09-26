import "server-only";

import type {
  ComponentFlowBinding,
  FormContinuationOutcome,
  FormContinuationRequest,
  FormContinuationService,
  IdentitySession,
  OrganizationSelectionCandidate,
} from "@vortex/contracts";

/**
 * #588: the Page request adapter that turns one form gesture into the exact server interface it
 * needs. Submit, Enter and Save are one `form_submit` binding whose values the surface supplies
 * from the person's current private draft (#587). `createPrivateFormSubmitAdapter` normalises that
 * submission into the caller inputs the binding declares, so the form endpoint runs the bound flow
 * exactly once, a surface can neither add an input the binding does not declare nor choose the
 * next node, and an unbounded answers bag or a malformed draft identity is refused instead of run
 * half-filled. A value the surface supplies is an input; nothing here reads authority or the
 * organisation from it.
 *
 * Continue, Cancel and resume carry the exact installation, release, form, flow, pending node and
 * completed-operation receipts the server issued. `createPageFormRequestAdapter` forwards them
 * unchanged to the web-independent continuation interface (#544), which is the one place that
 * compares them with trusted session and stored-run state. Page adds no second validation and no
 * continuation identity of its own, so a stale or forged target is refused there, not duplicated
 * here.
 */

const maximumFormValues = 500;
const maximumDraftIdLength = 200;

const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
  typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);

/**
 * The answers of the person's current private form draft. The draft identity is the exact #587
 * revision the answers were read from; it is present whenever the surface keeps a draft and is
 * absent only for a submission the surface made without one.
 */
export type PrivateFormSubmission = Readonly<{
  values: Readonly<Record<string, unknown>>;
  draft?: Readonly<{ draftId: string; revision: number }>;
}>;

/**
 * Reads the submission envelope a surface sends for a `form_submit` binding. It fails closed: an
 * unbounded or non-record answers bag has nothing to submit, and a draft identity that is present
 * but malformed (empty, fractional or non-positive revision) is refused rather than trusted.
 */
export const readPrivateFormSubmission = (
  candidate: unknown,
): PrivateFormSubmission | undefined => {
  if (!isRecord(candidate)) return undefined;
  const values = candidate.values;
  if (!isRecord(values) || Object.keys(values).length > maximumFormValues) return undefined;
  const draft = candidate.draft;
  if (draft === undefined) return { values };
  if (
    !isRecord(draft) ||
    typeof draft.draftId !== "string" ||
    draft.draftId.length === 0 ||
    draft.draftId.length > maximumDraftIdLength ||
    typeof draft.revision !== "number" ||
    !Number.isSafeInteger(draft.revision) ||
    draft.revision < 1
  )
    return undefined;
  return { values, draft: { draftId: draft.draftId, revision: draft.revision } };
};

/**
 * The endpoint's form-submit seam. It returns the caller inputs the binding declares, filled from
 * the answers of the person's current draft, or `undefined` so the endpoint refuses the submit. A
 * binding that declares the whole answer receives the submission's own values record; every other
 * declared caller input is named exactly.
 */
export type PrivateFormSubmitAdapter = (
  binding: ComponentFlowBinding,
  callerInputs: Readonly<Record<string, unknown>>,
) => Readonly<Record<string, unknown>> | undefined;

export const createPrivateFormSubmitAdapter =
  (): PrivateFormSubmitAdapter =>
  (binding, callerInputs) => {
    if (binding.event !== "form_submit") return undefined;
    const submission = readPrivateFormSubmission(callerInputs);
    if (submission === undefined) return undefined;
    const adapted: Record<string, unknown> = {};
    for (const input of Object.values(binding.flow.inputs)) {
      if (typeof input !== "object" || input === null || input.kind !== "caller") continue;
      // A binding that declares the whole answer receives the submission's own values record;
      // every other declared caller input is named exactly and must be present.
      if (input.name === "values") adapted[input.name] = submission.values;
      else if (Object.hasOwn(submission.values, input.name))
        adapted[input.name] = submission.values[input.name];
      else return undefined;
    }
    return adapted;
  };

export type PageFormRequestDependencies = Readonly<{ continuation: FormContinuationService }>;

/**
 * The Page side of a form gesture's continuation. Every method is a pass-through to the #544
 * interface: the caller supplies the server-issued evidence, and that interface compares it with
 * trusted state. Page names no next node and never resumes anything itself.
 */
export const createPageFormRequestAdapter = (dependencies: PageFormRequestDependencies) => {
  const forward = (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    request: FormContinuationRequest,
  ): Promise<FormContinuationOutcome> =>
    dependencies.continuation.continue(session, selection, request);

  return Object.freeze({
    /** Submits or continues the paused form with the answers the person's own draft holds. */
    submit: forward,
    /** Cancels the paused form; the flow follows its declared not-submitted path. */
    cancel: forward,
    /** Resumes the paused form with any answer kind the #544 contract declares. */
    resume: forward,
  });
};

export type PageFormRequestAdapter = ReturnType<typeof createPageFormRequestAdapter>;
