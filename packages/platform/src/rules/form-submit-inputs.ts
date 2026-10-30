import { isRecord } from "../catalogue/runtime-primitives";
import type { FlowBindingInput } from "../workflows/flow-contracts";

const maximumFormValues = 500;

/** The answers a surface submits for a `form_submit` binding. */
type PrivateFormSubmission = Readonly<{
  values: Readonly<Record<string, unknown>>;
  /** Whole-record patch membership, independent of individually mapped answers. */
  recordChanges?: readonly string[];
  selectedOwnerGroupId?: string;
  /** A guided form's own stored draft the submit confirms; the server alone fills it from the draft. */
  draft?: Readonly<{ draftId: string; revision: number }>;
}>;

/**
 * Reads the submission envelope a surface sends for a `form_submit` binding. It fails closed: an
 * unbounded or non-record answers bag has nothing to submit, an unknown envelope key is refused,
 * and a draft identity is refused until a draft authority can verify it (see `form-request`).
 */
const readPrivateFormSubmission = (candidate: unknown): PrivateFormSubmission | undefined => {
  if (!isRecord(candidate)) return undefined;
  if (
    Object.keys(candidate).some(
      (key) =>
        key !== "values" &&
        key !== "recordChanges" &&
        key !== "selectedOwnerGroupId" &&
        key !== "draft",
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
  const draft = candidate.draft;
  if (
    draft !== undefined &&
    (!isRecord(draft) ||
      Object.keys(draft).length !== 2 ||
      typeof draft.draftId !== "string" ||
      !Number.isSafeInteger(draft.revision))
  )
    return undefined;
  return {
    values,
    ...(draft === undefined
      ? {}
      : { draft: { draftId: draft.draftId as string, revision: draft.revision as number } }),
    ...(changes === undefined ? {} : { recordChanges: changes as string[] }),
    ...(candidate.selectedOwnerGroupId === undefined
      ? {}
      : { selectedOwnerGroupId: candidate.selectedOwnerGroupId }),
  };
};

/**
 * The one form-submit mapping, shared by the flow endpoint and the page runner. It returns the
 * caller inputs the binding declares, filled from the submitted answers, or `undefined` so the
 * caller refuses the submit. A binding that declares the whole answer receives its record patch
 * when present; every other declared caller input is named exactly, except that the form's
 * separate owner Group selection maps to the binding's declared `selected_owner_group_id` input.
 *
 * `subject` is the record the form was rendered for, named by the surface from its own address. A
 * binding that declares a `record` caller input the answers do not carry receives that record's
 * identity. It is only a candidate: the protected save decides whether the person may change it.
 */
export const adaptFormSubmitInputs = (
  declared: Readonly<Record<string, FlowBindingInput>>,
  callerInputs: Readonly<Record<string, unknown>>,
  subject?: Readonly<{ recordId: string }>,
): Readonly<Record<string, unknown>> | undefined => {
  const submission = readPrivateFormSubmission(callerInputs);
  if (submission === undefined) return undefined;
  const needsOwnerGroup = Object.values(declared).some(
    (input) =>
      typeof input === "object" &&
      input !== null &&
      input.kind === "caller" &&
      input.name === "selected_owner_group_id",
  );
  if (needsOwnerGroup !== (submission.selectedOwnerGroupId !== undefined)) return undefined;
  const adapted: Record<string, unknown> = {};
  for (const input of Object.values(declared)) {
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
    else if (input.name === "draft_id" && submission.draft !== undefined)
      adapted[input.name] = submission.draft.draftId;
    else if (input.name === "revision" && submission.draft !== undefined)
      adapted[input.name] = submission.draft.revision;
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
