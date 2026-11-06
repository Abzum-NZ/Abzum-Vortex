"use client";

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { describeFailure } from "@vortex/platform/schema";
import type { FlowVerification, FlowVerificationOptions } from "@vortex/ui";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
import { Button } from "@vortex/ui/components/button";
import { Spinner } from "@vortex/ui/components/spinner";
import {
  readStepUpState,
  reauthenticateInPlace,
  type StepUpAddress,
  type StepUpState,
} from "../auth/step-up-actions";
import { AuthenticatorCode, EnrolAuthenticator, ProofForm } from "./authenticator-proof";

type Ready = Extract<StepUpState, { kind: "ready" }>;

/**
 * Whether this step needs the authenticator's code. `platform_two_step` always does; `two_step_if_enrolled` only for a person who has an authenticator. `two_step`
 * does unless the organisation turned the requirement off. A person who signed in again here and
 * has an authenticator gives its code too, so the session this step leaves is as strong as the one
 * signing in produces. The database decides again where the protected step runs.
 */
const needsAuthenticator = (
  requires: FlowVerification,
  state: Ready,
  signedInAgainHere: boolean,
): boolean =>
  requires === "platform_two_step" ||
  (requires === "two_step" && state.organizationRequiresTwoStep) ||
  (requires === "two_step_if_enrolled" && state.hasSecondFactor) ||
  (signedInAgainHere && state.authenticator.kind === "challenge");

/** Which proof still has to be given, from what the session already shows. */
const missingProof = (
  requires: FlowVerification,
  state: Ready,
  signedInAgainHere: boolean,
): "password" | "authenticator" | undefined =>
  !state.signedInRecently
    ? "password"
    : needsAuthenticator(requires, state, signedInAgainHere) && !state.twoStepRecently
      ? "authenticator"
      : undefined;

/**
 * The proof a Verify step asks for, inside the step: the password for a recent sign-in, then the
 * authenticator's code (or setting one up) for two-step verification. What the session already
 * shows is read first and only the missing proof is asked for. The platform checks again where the
 * protected step runs; this only collects the proof and moves the flow on.
 */
function StepUpPanel({
  address,
  requires,
  verified,
}: Readonly<{
  address: StepUpAddress | undefined;
  requires: FlowVerification;
  verified: () => void;
}>): ReactElement {
  const [state, setState] = useState<StepUpState>();
  const [attempt, setAttempt] = useState(0);
  const addressRef = useRef(address);
  const finished = useRef(false);
  const signedInAgainHere = useRef(false);
  const read = useCallback((): void => {
    readStepUpState(addressRef.current)
      .then(setState)
      .catch((error: unknown) => {
        console.error(`[verification] the session could not be read: ${describeFailure(error)}`);
        setState({ kind: "unavailable" });
      });
  }, []);
  useEffect(() => {
    setState(undefined);
    read();
  }, [attempt, read]);
  const missing =
    state?.kind === "ready" ? missingProof(requires, state, signedInAgainHere.current) : undefined;
  useEffect(() => {
    if (state?.kind !== "ready" || missing !== undefined || finished.current) return;
    finished.current = true;
    verified();
  }, [state, missing, verified]);

  if (state === undefined)
    return (
      <div className="flex items-center gap-3 text-sm" role="status">
        <Spinner />
        <span>Checking your session…</span>
      </div>
    );
  if (state.kind === "unavailable")
    return (
      <div className="flex flex-col gap-3">
        <Alert variant="destructive">
          <AlertDescription>Verification is not available right now.</AlertDescription>
        </Alert>
        <div>
          <Button type="button" variant="outline" onClick={() => setAttempt((count) => count + 1)}>
            Try again
          </Button>
        </div>
      </div>
    );
  if (missing === "password")
    return (
      <ProofForm
        id="step-up-password"
        label="Password"
        type="password"
        autoComplete="current-password"
        submitLabel="Sign in again"
        pendingLabel="Signing in…"
        run={async (password) => {
          const result = await reauthenticateInPlace(password);
          if (result.kind === "error") return result.error;
          signedInAgainHere.current = true;
          read();
          return undefined;
        }}
      />
    );
  if (missing === "authenticator")
    return state.authenticator.kind === "challenge" ? (
      <AuthenticatorCode factorId={state.authenticator.factorId} onVerified={read} />
    ) : (
      <EnrolAuthenticator onVerified={read} />
    );
  return (
    <div className="flex items-center gap-3 text-sm" role="status">
      <Spinner />
      <span>Verified. Continuing…</span>
    </div>
  );
}

/**
 * What a flow shell passes to the flow host so a Verify step asks inside the dialog. The address
 * is the application the flow runs in, read when a step starts (Studio runs flows of the page it
 * shows now); with none, the code is asked for. Its organisation's two-step setting decides whether
 * `two_step` asks for the authenticator's code.
 */
export const stepUpVerification = (
  addressOfFlow: () => StepUpAddress | undefined,
): FlowVerificationOptions => ({
  status: async (requires) => {
    const state = await readStepUpState(addressOfFlow());
    return state.kind === "ready" && missingProof(requires, state, false) === undefined
      ? "satisfied"
      : "needed";
  },
  render: (requires, controls) => (
    <StepUpPanel address={addressOfFlow()} requires={requires} verified={controls.verified} />
  ),
});
