/*
 * The limits a flow confirmation shares with the browser that presents it, apart from the flow
 * contracts, so the page reads them without loading those contracts.
 */

/** Maximum number of detail lines a flow confirmation can present for explicit review. */
export const maximumFlowConfirmationDetailLines = 500;

/** What a Verify step may ask the person to prove: a recent sign-in, or two-step verification. */
export const flowVerificationRequirements = ["recent_sign_in", "two_step"] as const;

/** The most steps a flow's guided dialog lists. */
export const maximumFlowWizardSteps = 8;
