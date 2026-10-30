import "server-only";

import { adaptFormSubmitInputs } from "../rules/form-submit-inputs";
import type { ComponentFlowBinding } from "../definition/application-flow-bindings";

/**
 * One form gesture turned into the exact server interface it needs. Submit, Enter and Save
 * are one `form_submit` binding whose answers the surface supplies. `adaptPrivateFormSubmit`
 * normalises that submission into the caller inputs the binding
 * declares, including a separate initial owner Group when the binding requires it, so the form
 * endpoint runs the bound flow exactly once, a surface can neither add an input the binding does
 * not declare nor choose the next node, and an unbounded answers bag is
 * refused instead of run half-filled. A value the surface supplies is an input; nothing here reads
 * authority or the organisation from it.
 *
 * Private drafts (`form-drafts`) fail closed. A draft's answers may only be read through the draft
 * authority for the verified person, and no concrete draft authority is composed on the web server
 * yet, so a submission that names a draft is refused rather than run with answers nobody verified
 * against that draft revision.
 *
 * Continue, Cancel and resume carry the exact installation, release, form, flow, pending node and
 * completed-operation receipts the server issued. The flow invocation forwards them unchanged to
 * the web-independent form continuation interface, which is the one place that
 * compares them with trusted session and stored-run state. Page adds no second validation and no
 * continuation identity of its own, so a stale or forged target is refused there, not duplicated
 * here.
 */

/** The endpoint's form-submit seam: the one mapping in `adaptFormSubmitInputs`, for a `form_submit` binding only. */
export const adaptPrivateFormSubmit = (
  binding: ComponentFlowBinding,
  callerInputs: Readonly<Record<string, unknown>>,
  subject?: Readonly<{ recordId: string }>,
): Readonly<Record<string, unknown>> | undefined =>
  binding.event === "form_submit"
    ? adaptFormSubmitInputs(binding.flow.inputs, callerInputs, subject)
    : undefined;
