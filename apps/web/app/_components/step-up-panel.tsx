"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import { describeFailure } from "@vortex/platform/schema";
import type { FlowVerification, FlowVerificationOptions } from "@vortex/ui";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
import { Button } from "@vortex/ui/components/button";
import { Field, FieldDescription } from "@vortex/ui/components/field";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { Spinner } from "@vortex/ui/components/spinner";
import {
  enrolAuthenticatorInPlace,
  readStepUpState,
  reauthenticateInPlace,
  verifyAuthenticatorInPlace,
  type StepUpState,
} from "../auth/step-up-actions";

type Ready = Extract<StepUpState, { kind: "ready" }>;

/** Which proof still has to be given, from what the session already shows. */
const missingProof = (
  requires: FlowVerification,
  state: Ready,
): "password" | "authenticator" | undefined =>
  !state.signedInRecently
    ? "password"
    : requires === "two_step" && !state.twoStepRecently
      ? "authenticator"
      : undefined;

/** One field and one button in a form that submits on Enter; the proof goes to the platform's own journey. */
function ProofForm({
  id,
  label,
  hint,
  type,
  inputMode,
  autoComplete,
  maxLength,
  submitLabel,
  pendingLabel,
  run,
}: Readonly<{
  id: string;
  label: string;
  hint?: string;
  type: "password" | "text";
  inputMode?: "numeric";
  autoComplete: string;
  maxLength?: number;
  submitLabel: string;
  pendingLabel: string;
  run: (value: string) => Promise<string | undefined>;
}>): ReactElement {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (pending || value.length === 0) return;
    setPending(true);
    setProblem(undefined);
    run(value)
      .then((failed) => {
        if (failed !== undefined) {
          setProblem(failed);
          setValue("");
        }
      })
      .catch((error: unknown) => {
        console.error(`[verification] the proof could not be sent: ${describeFailure(error)}`);
        setProblem("This could not be checked right now. Try again.");
      })
      .finally(() => setPending(false));
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
      <Field>
        <Label htmlFor={id}>{label}</Label>
        <Input
          id={id}
          name={id}
          type={type}
          autoFocus
          autoComplete={autoComplete}
          value={value}
          disabled={pending}
          aria-invalid={problem === undefined ? undefined : true}
          onChange={(event) => setValue(event.target.value)}
          {...(inputMode === undefined ? {} : { inputMode })}
          {...(maxLength === undefined ? {} : { maxLength })}
        />
        {hint === undefined ? null : <FieldDescription>{hint}</FieldDescription>}
      </Field>
      {problem === undefined ? null : (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      <div>
        <Button type="submit" disabled={pending || value.length === 0}>
          {pending ? pendingLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** The setup key and QR code of a new authenticator, shown once, with the code field that finishes it. */
function EnrolAuthenticator({ onVerified }: Readonly<{ onVerified: () => void }>): ReactElement {
  const [enrolment, setEnrolment] =
    useState<Readonly<{ factorId: string; secret: string; qrCode: string }>>();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const start = (): void => {
    setPending(true);
    setProblem(undefined);
    enrolAuthenticatorInPlace()
      .then((result) => {
        if (result.kind === "enrolled")
          setEnrolment({
            factorId: result.factorId,
            secret: result.secret,
            qrCode: result.qrCode,
          });
        else setProblem(result.error);
      })
      .catch((error: unknown) => {
        console.error(
          `[verification] the authenticator could not be set up: ${describeFailure(error)}`,
        );
        setProblem("Two-step verification could not be set up. Try again.");
      })
      .finally(() => setPending(false));
  };
  if (enrolment === undefined)
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          You have no authenticator app set up yet. Set one up here; this step carries on
          afterwards.
        </p>
        {problem === undefined ? null : (
          <Alert variant="destructive">
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        )}
        <div>
          <Button type="button" disabled={pending} onClick={start}>
            {pending ? "Setting up…" : "Set up authenticator"}
          </Button>
        </div>
      </div>
    );
  return (
    <div className="flex flex-col gap-3">
      <FieldDescription>
        Scan this QR code with your authenticator app, then enter the code it shows.
      </FieldDescription>
      {/* The QR code is an SVG data address from the identity provider, shown as an image. */}
      <img
        src={enrolment.qrCode}
        alt="QR code for your authenticator app"
        width={160}
        height={160}
        className="rounded-md border bg-white p-2"
      />
      <FieldDescription>
        If you cannot scan it, add the account with this setup key:{" "}
        <code className="break-all">{enrolment.secret}</code>
      </FieldDescription>
      <AuthenticatorCode factorId={enrolment.factorId} onVerified={onVerified} />
    </div>
  );
}

function AuthenticatorCode({
  factorId,
  onVerified,
}: Readonly<{ factorId: string; onVerified: () => void }>): ReactElement {
  return (
    <ProofForm
      id="step-up-code"
      label="Authenticator code"
      type="text"
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      submitLabel="Verify"
      pendingLabel="Verifying…"
      run={async (code) => {
        const result = await verifyAuthenticatorInPlace(factorId, code.trim());
        if (result.kind === "error") return result.error;
        onVerified();
        return undefined;
      }}
    />
  );
}

/**
 * The proof a Verify step asks for, inside the step: the password for a recent sign-in, then the
 * authenticator's code (or setting one up) for two-step verification. What the session already
 * shows is read first and only the missing proof is asked for. The platform checks again where the
 * protected step runs; this only collects the proof and moves the flow on.
 */
function StepUpPanel({
  requires,
  verified,
}: Readonly<{ requires: FlowVerification; verified: () => void }>): ReactElement {
  const [state, setState] = useState<StepUpState>();
  const [attempt, setAttempt] = useState(0);
  const finished = useRef(false);
  const read = useCallback((): void => {
    readStepUpState()
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
  const missing = state?.kind === "ready" ? missingProof(requires, state) : undefined;
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

/** What a flow shell passes to the flow host so a Verify step asks inside the dialog. */
export const stepUpVerification: FlowVerificationOptions = {
  status: async (requires) => {
    const state = await readStepUpState();
    return state.kind === "ready" && missingProof(requires, state) === undefined
      ? "satisfied"
      : "needed";
  },
  render: (requires, controls) => <StepUpPanel requires={requires} verified={controls.verified} />,
};
