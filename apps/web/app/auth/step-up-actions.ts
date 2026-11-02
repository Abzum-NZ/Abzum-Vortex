"use server";

import {
  builderRecentAuthentication,
  roleAcceptanceAuthentication,
  signInWithPassword,
} from "@vortex/platform/server";
import { mapWebError } from "../_lib/web-error-mapper";
import { getIdentityJourneyConfiguration } from "./_lib/authority-configuration";
import {
  bootstrapIdentitySession,
  enrollMfaFactor,
  readMfaFactor,
  resolveVerifiedIdentity,
  verifyMfaFactor,
} from "./_lib/session-server";

/*
 * The proofs a flow asks for inside its own dialogs (a Verify step): signing in again for a recent
 * sign-in, and the authenticator for two-step verification. They collect the proof only. The
 * protected step the flow runs next asks the platform again, with the 15-minute and one-hour
 * windows it always used, so nothing here is trusted for the change itself. No code, password or
 * secret is stored or logged here; the setup key and QR code are returned once to the signed-in
 * person who asked for them.
 */

/** How long before a window ends a proof stops counting as recent, so a step does not run into the end. */
const marginSeconds = 60;

const recentWithin = (at: string | undefined, windowSeconds: number): boolean =>
  at !== undefined && Date.now() - Date.parse(at) < (windowSeconds - marginSeconds) * 1_000;

export type StepUpState =
  | Readonly<{
      kind: "ready";
      /** The person signed in within the window a protected change asks for. */
      signedInRecently: boolean;
      /** The person gave an authenticator code within the window a role change asks for. */
      twoStepRecently: boolean;
      /** The authenticator they have, or that they have none yet. */
      authenticator:
        Readonly<{ kind: "challenge"; factorId: string }> | Readonly<{ kind: "setup" }>;
    }>
  | Readonly<{ kind: "unavailable" }>;

/** What the person has already proven in this session, and what they could still give. */
export async function readStepUpState(): Promise<StepUpState> {
  const identity = await resolveVerifiedIdentity();
  if (identity === undefined) return { kind: "unavailable" };
  const factor = await readMfaFactor();
  if (factor.kind === "unavailable") return { kind: "unavailable" };
  return {
    kind: "ready",
    signedInRecently: recentWithin(
      identity.primaryAuthenticatedAt,
      builderRecentAuthentication.maximumAgeSeconds,
    ),
    twoStepRecently: recentWithin(
      identity.multiFactorAuthenticatedAt,
      roleAcceptanceAuthentication.maximumAgeSeconds,
    ),
    authenticator:
      factor.kind === "challenge"
        ? { kind: "challenge", factorId: factor.factorId }
        : { kind: "setup" },
  };
}

type StepUpResult = Readonly<{ kind: "done" }> | Readonly<{ kind: "error"; error: string }>;

/**
 * Signs the person in again with their password, for a recent sign-in. The account is the one
 * signed in now, never one the browser names, and a fresh session replaces the old one exactly as
 * signing in does.
 */
export async function reauthenticateInPlace(password: string): Promise<StepUpResult> {
  const refused = {
    kind: "error",
    error: "That password was not accepted. Check it and try again.",
  } as const;
  if (typeof password !== "string" || password.length === 0 || password.length > 1_024)
    return refused;
  const identity = await resolveVerifiedIdentity();
  if (identity === undefined)
    return { kind: "error", error: "Your session has ended. Sign in again to continue." };
  try {
    const result = await signInWithPassword(
      getIdentityJourneyConfiguration(),
      identity.verifiedPrimaryEmail,
      password,
    );
    if (!result.ok)
      return result.code === "vortex.identity.invalid_credentials"
        ? refused
        : { kind: "error", error: "Signing in is not available right now. Try again." };
    const session = await bootstrapIdentitySession(result);
    return session.kind === "active"
      ? { kind: "done" }
      : { kind: "error", error: "Signing in is not available right now. Try again." };
  } catch (error) {
    return mapWebError(error, {
      route: "auth/step-up",
      operation: "reauthenticate",
      code: "STEP_UP_REAUTHENTICATE_FAILED",
      fallback: {
        kind: "error",
        error: "Signing in is not available right now. Try again.",
      } as const,
    });
  }
}

/** Sets up an authenticator for the signed-in person: the setup key and QR code, shown once. */
export async function enrolAuthenticatorInPlace(): Promise<
  | Readonly<{ kind: "enrolled"; factorId: string; secret: string; qrCode: string }>
  | Readonly<{ kind: "error"; error: string }>
> {
  const enrolled = await enrollMfaFactor();
  return enrolled.kind === "enrolled"
    ? enrolled
    : { kind: "error", error: "Two-step verification could not be set up. Try again." };
}

/** Gives the code the authenticator shows, for the authenticator the signed-in person has. */
export async function verifyAuthenticatorInPlace(
  factorId: string,
  code: string,
): Promise<StepUpResult> {
  if (
    typeof factorId !== "string" ||
    typeof code !== "string" ||
    !/^[0-9a-f-]{36}$/iu.test(factorId) ||
    !/^\d{6}$/u.test(code) ||
    !(await verifyMfaFactor(factorId, code))
  )
    return { kind: "error", error: "The code could not be verified. Check it and try again." };
  return { kind: "done" };
}
