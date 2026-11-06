/*
 * The limits a flow confirmation shares with the browser that presents it, apart from the flow
 * contracts, so the page reads them without loading those contracts.
 */

/** Maximum number of detail lines a flow confirmation can present for explicit review. */
export const maximumFlowConfirmationDetailLines = 500;

/**
 * What a Verify step may ask the person to prove: a recent sign-in, two-step verification as the
 * organisation requires it (the organisation can turn it off on a development instance), or
 * two-step verification that no setting can waive (tenant administration), or the authenticator's
 * code only for a person who has an authenticator (turning the organisation's setting off).
 */
export const flowVerificationRequirements = [
  "recent_sign_in",
  "two_step",
  "platform_two_step",
  "two_step_if_enrolled",
] as const;

/** The most steps a flow's guided dialog lists. */
export const maximumFlowWizardSteps = 8;
