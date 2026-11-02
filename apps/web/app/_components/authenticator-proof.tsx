"use client";

import { useState, type FormEvent, type ReactElement } from "react";
import { describeFailure } from "@vortex/platform/schema";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
import { Button } from "@vortex/ui/components/button";
import { Field, FieldDescription } from "@vortex/ui/components/field";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { enrolAuthenticatorInPlace, verifyAuthenticatorInPlace } from "../auth/step-up-actions";

/** One field and one button in a form that submits on Enter; the proof goes to the platform's own journey. */
export function ProofForm({
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
export function EnrolAuthenticator({
  onVerified,
}: Readonly<{ onVerified: () => void }>): ReactElement {
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

export function AuthenticatorCode({
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
