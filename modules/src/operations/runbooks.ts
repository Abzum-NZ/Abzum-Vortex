/**
 * Concrete Operations runbooks for the six spec 19 critical incident codes.
 *
 * Each entry is keyed by the exact `runbookReference` an alert producer supplies in its
 * `AlertRecord`, so an incident's `runbook_reference` resolves to one page. The six codes are
 * organisation separation, credential exposure, failed privacy removal, unrecoverable event
 * sequence, failed backup and production access-test failure (spec 19, "Alerts and incident
 * handling"). The text is operational guidance only: it never grants customer-content access and
 * never asks an operator to approve their own action.
 */

export interface OperationsRunbook {
  /** The alert code the runbook answers, as a namespaced key. */
  readonly code: string;
  /** The exact runbook reference carried by the alert and stored on the incident. */
  readonly runbookReference: string;
  /** The alert's accountable owning role, as a builder key. */
  readonly owningRole: string;
  readonly title: string;
  readonly summary: string;
  readonly steps: readonly string[];
}

const runbookCodes = Object.freeze({
  organisationSeparation: "vortex.operations.alerts.organisation_separation",
  credentialExposure: "vortex.operations.alerts.credential_exposure",
  privacyRemovalFailure: "vortex.operations.alerts.privacy_removal_failure",
  eventSequenceFailure: "vortex.operations.alerts.event_sequence_failure",
  backupFailure: "vortex.operations.alerts.backup_failure",
  productionAccessTestFailure: "vortex.operations.alerts.production_access_test_failure",
} as const);

const runbookReferences = Object.freeze({
  organisationSeparation: "vortex.operations.runbooks.organisation_separation",
  credentialExposure: "vortex.operations.runbooks.credential_exposure",
  privacyRemovalFailure: "vortex.operations.runbooks.privacy_removal_failure",
  eventSequenceFailure: "vortex.operations.runbooks.event_sequence_failure",
  backupFailure: "vortex.operations.runbooks.backup_failure",
  productionAccessTestFailure: "vortex.operations.runbooks.production_access_test_failure",
} as const);

/** The bounded operator actions every incident exposes, named on each runbook page. */
export const operationsRunbookActionSet = Object.freeze([
  "Acknowledge",
  "Escalate",
  "Resolve",
]);

export const operationsRunbooks: readonly OperationsRunbook[] = Object.freeze([
  {
    code: runbookCodes.organisationSeparation,
    runbookReference: runbookReferences.organisationSeparation,
    owningRole: "security_operator",
    title: "Organisation separation incident",
    summary:
      "A request, read or write crossed an organisation boundary, or a separation check failed. Customer content is not opened while the boundary is in question.",
    steps: [
      "Read the alert from the protected signal feed and confirm the affected organisations and service from its content-free fields.",
      "Record scope and preserve the signal evidence on the open incident; do not copy customer content into any incident field.",
      "Contain by revoking the affected cross-organisation route or grant through its owning Access operation; never widen a scope to investigate.",
      "Recover by re-running the separation check for the affected organisation pair and recording its result.",
      "Verify that no further cross-organisation read or write is possible and that no data was copied into Operations records.",
      "Escalate to the owning role while any boundary remains open; acknowledge first when work has started.",
      "Record cause and follow-up work, and resolve only after the separation check passes.",
    ],
  },
  {
    code: runbookCodes.credentialExposure,
    runbookReference: runbookReferences.credentialExposure,
    owningRole: "security_operator",
    title: "Lost or exposed secret",
    summary:
      "A credential or signing key may be exposed. The runbook rotates it and proves the old value no longer works, without ever recording the secret.",
    steps: [
      "Identify the secret's scope from the alert and its owning configuration; never paste the exposed value into the incident.",
      "Rotate the secret through its owning secret operation and revoke sessions or tokens derived from it.",
      "For a federation key, publish the next public key, overlap verification, then retire the old key after the replay window closes.",
      "Verify the new credential is in use and that the retired value is refused on the next request.",
      "Escalate to the owning role if rotation or revocation is incomplete; acknowledge first when work has started.",
      "Record cause and follow-up work, and resolve only after the old value is proven refused.",
    ],
  },
  {
    code: runbookCodes.privacyRemovalFailure,
    runbookReference: runbookReferences.privacyRemovalFailure,
    owningRole: "privacy_operator",
    title: "Failed privacy removal",
    summary:
      "A removal or revocation did not complete or its surviving evidence is uncertain. The affected scope stays closed until the outcome is established.",
    steps: [
      "Read the content-free removal/revocation intent and outcome from the surviving journal; never read removed values.",
      "Keep the affected scope unavailable while the outcome is uncertain; do not infer permission from a missing completion.",
      "Replay the removal or revocation idempotently using the same operation identifier.",
      "Record the committed outcome externally before reporting success, so a crash cannot lose it.",
      "Verify that the scope remains closed and that later entries reconcile with the restore boundary.",
      "Escalate to the owning privacy role when the outcome cannot be established; acknowledge first when work has started.",
      "Record cause and follow-up work, and resolve only after reconciliation is proven.",
    ],
  },
  {
    code: runbookCodes.eventSequenceFailure,
    runbookReference: runbookReferences.eventSequenceFailure,
    owningRole: "operations_operator",
    title: "Unrecoverable event sequence",
    summary:
      "An event sequence is stalled or a gap cannot be recovered. Downstream work is reconciled before the sequence is declared healthy.",
    steps: [
      "Identify the blocked sequence and its age from the event measures; the alert carries no payload.",
      "Confirm the sequence high-water mark and whether any events were skipped rather than delayed.",
      "Retry the failed events through their ordinary delivery path and watch event age return to normal.",
      "Verify that downstream projections and reconciliation differences account for every recovered event.",
      "Escalate to the owning role if the blockage persists or a gap is confirmed; acknowledge first when work has started.",
      "Record cause and follow-up work, and resolve only after the sequence and its downstream effects are verified.",
    ],
  },
  {
    code: runbookCodes.backupFailure,
    runbookReference: runbookReferences.backupFailure,
    owningRole: "database_operator",
    title: "Failed backup",
    summary:
      "A backup did not complete or its completeness is unproven. No recovery point is claimed until an independent copy is verified.",
    steps: [
      "Identify the failed backup object and its requested expiry from the backup inventory alert.",
      "Confirm the independent encrypted copy, checksum and completion against the inventory; a job reporting success is not proof.",
      "Re-run the backup and verify the new object appears in the inventory within the 48-hour retention window.",
      "Treat the provider-managed copy as unavailable and prove recovery from the independent copy.",
      "Escalate to the owning role when no verified recovery point exists; acknowledge first when work has started.",
      "Record cause and follow-up work, and resolve only after a verified backup and inventory entry exist.",
    ],
  },
  {
    code: runbookCodes.productionAccessTestFailure,
    runbookReference: runbookReferences.productionAccessTestFailure,
    owningRole: "security_operator",
    title: "Production access-test failure",
    summary:
      "A production access check failed. The failure is diagnosed and re-tested without widening authority or changing permissions to pass.",
    steps: [
      "Identify the failing access test and the exact expected decision from the alert; never read customer content to explain it.",
      "Re-run the test under the ordinary permission model and record the refusal or mismatch verbatim.",
      "Confirm whether a missing, stale or widened authority caused the failure; do not change permissions or protections to pass the test.",
      "Verify the test passes on its next run and that no other access decision changed.",
      "Escalate to the owning security role when authority must change; acknowledge first when work has started.",
      "Record cause and follow-up work, and resolve only after the test passes under unchanged authority.",
    ],
  },
]);

const referenceTail = (reference: string): string => {
  const segments = reference.split(".");
  return segments[segments.length - 1] ?? reference;
};

/** The page key that carries one runbook, derived from its exact `runbookReference`. */
export const runbookPageKey = (runbook: OperationsRunbook): string =>
  `runbook_${referenceTail(runbook.runbookReference)}`;

/** The page text for one runbook: reference, owner, summary, concrete steps and the action set. */
export const runbookPageText = (runbook: OperationsRunbook): string =>
  [
    `Alert code: ${runbook.code}`,
    `Runbook reference: ${runbook.runbookReference}`,
    `Owning role: ${runbook.owningRole}`,
    "",
    runbook.summary,
    "",
    "Operator steps:",
    ...runbook.steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    `Bounded operator actions on the incident: ${operationsRunbookActionSet.join(", ")}.`,
    "Attach a signal on any open incident; a re-attached signal updates the same incident.",
    "No action reads customer content and no action approves itself.",
  ].join("\n");
