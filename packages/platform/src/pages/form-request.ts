import "server-only";

import { isRecord } from "../catalogue/runtime-primitives";
import type { ComponentFlowBinding } from "../definition/application-flow-bindings";

/**
 * #588: one form gesture turned into the exact server interface it needs. Submit, Enter and Save
 * are one `form_submit` binding whose answers the surface supplies. `adaptPrivateFormSubmit`
 * normalises that submission into the caller inputs the binding
 * declares, including a separate initial owner Group when the binding requires it, so the form
 * endpoint runs the bound flow exactly once, a surface can neither add an input the binding does
 * not declare nor choose the next node, and an unbounded answers bag is
 * refused instead of run half-filled. A value the surface supplies is an input; nothing here reads
 * authority or the organisation from it.
 *
 * Private drafts (#587) fail closed. A draft's answers may only be read through the draft authority
 * for the verified person, and no concrete draft authority is composed on the web server yet, so a
 * submission that names a draft is refused rather than run with answers nobody verified against
 * that draft revision.
 *
 * Continue, Cancel and resume carry the exact installation, release, form, flow, pending node and
 * completed-operation receipts the server issued. The flow invocation forwards them unchanged to the web-independent continuation interface (#544), which is the one place that
 * compares them with trusted session and stored-run state. Page adds no second validation and no
 * continuation identity of its own, so a stale or forged target is refused there, not duplicated
 * here.
 */

const maximumFormValues = 500;

/** The answers a surface submits for a `form_submit` binding. */
export type PrivateFormSubmission = Readonly<{
  values: Readonly<Record<string, unknown>>;
  /** Whole-record patch membership, independent of individually mapped answers. */
  recordChanges?: readonly string[];
  selectedOwnerGroupId?: string;
}>;

/**
 * Reads the submission envelope a surface sends for a `form_submit` binding. It fails closed: an
 * unbounded or non-record answers bag has nothing to submit, an unknown envelope key is refused,
 * and a draft identity is refused until a draft authority can verify it (see above).
 */
export const readPrivateFormSubmission = (
  candidate: unknown,
): PrivateFormSubmission | undefined => {
  if (!isRecord(candidate)) return undefined;
  if (
    Object.keys(candidate).some(
      (key) => key !== "values" && key !== "recordChanges" && key !== "selectedOwnerGroupId",
    )
  )
    return undefined;
  const values = candidate.values;
  if (!isRecord(values) || Object.keys(values).length > maximumFormValues) return undefined;
  const changes = candidate.recordChanges;
  if (
    changes !== undefined &&
    (!Array.isArray(changes) ||
      changes.length > maximumFormValues ||
      changes.some((name) => typeof name !== "string" || !Object.hasOwn(values, name)) ||
      new Set(changes).size !== changes.length)
  )
    return undefined;
  if (
    candidate.selectedOwnerGroupId !== undefined &&
    typeof candidate.selectedOwnerGroupId !== "string"
  )
    return undefined;
  return {
    values,
    ...(changes === undefined ? {} : { recordChanges: changes as string[] }),
    ...(candidate.selectedOwnerGroupId === undefined
      ? {}
      : { selectedOwnerGroupId: candidate.selectedOwnerGroupId }),
  };
};

/**
 * The endpoint's form-submit seam. It returns the caller inputs the binding declares, filled from
 * the submitted answers, or `undefined` so the endpoint refuses the submit. A binding that
 * declares the whole answer receives its record patch when present; every other declared
 * caller input is named exactly, except that the form's separate owner Group selection maps to
 * the binding's declared `selected_owner_group_id` input.
 *
 * `subject` is the record the form was rendered for, named by the surface from its own address. A
 * binding that declares a `record` caller input the answers do not carry receives that record's
 * identity. It is only a candidate: the protected save decides whether the person may change it.
 */
export const adaptPrivateFormSubmit = (
  binding: ComponentFlowBinding,
  callerInputs: Readonly<Record<string, unknown>>,
  subject?: Readonly<{ recordId: string }>,
): Readonly<Record<string, unknown>> | undefined => {
  if (binding.event !== "form_submit") return undefined;
  const submission = readPrivateFormSubmission(callerInputs);
  if (submission === undefined) return undefined;
  const needsOwnerGroup = Object.values(binding.flow.inputs).some(
    (input) =>
      typeof input === "object" &&
      input !== null &&
      input.kind === "caller" &&
      input.name === "selected_owner_group_id",
  );
  if (needsOwnerGroup !== (submission.selectedOwnerGroupId !== undefined)) return undefined;
  const adapted: Record<string, unknown> = {};
  for (const input of Object.values(binding.flow.inputs)) {
    if (typeof input !== "object" || input === null || input.kind !== "caller") continue;
    // The whole-record input receives its patch; individual inputs receive complete answers.
    // Every other declared caller input is named exactly and must be present.
    if (input.name === "values")
      adapted[input.name] =
        submission.recordChanges === undefined
          ? submission.values
          : Object.fromEntries(
              submission.recordChanges.map((name) => [name, submission.values[name]]),
            );
    else if (input.name === "selected_owner_group_id")
      adapted[input.name] = submission.selectedOwnerGroupId;
    else if (Object.hasOwn(submission.values, input.name))
      adapted[input.name] = submission.values[input.name];
    else if (input.name === "record" && subject !== undefined)
      adapted[input.name] = subject.recordId;
    else return undefined;
  }
  return adapted;
};
