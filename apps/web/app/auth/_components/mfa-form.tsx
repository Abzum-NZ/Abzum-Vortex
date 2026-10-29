"use client";

import { useActionState } from "react";
import { Field, FieldDescription } from "@vortex/ui/components/field";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { completeMfa, type MfaFormState } from "../actions";
import { SubmitButton } from "./submit-button";

export function MfaForm({
  initial,
  continuation,
}: {
  initial: MfaFormState;
  continuation?: string;
}) {
  const [state, action] = useActionState(completeMfa, initial);
  return (
    <form className="flex flex-col gap-5" action={action}>
      {continuation === undefined ? null : (
        <input type="hidden" name="continuation" value={continuation} />
      )}
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.kind === "setup" ? (
        <>
          <p>Set up an authenticator app to use two-step verification for protected operations.</p>
          <button name="intent" value="enroll" type="submit" className="underline">
            Set up authenticator
          </button>
        </>
      ) : (
        <>
          {state.kind === "enrolled" ? (
            <FieldDescription>
              Add an account in your authenticator app using this setup key:{" "}
              <code>{state.secret}</code>
            </FieldDescription>
          ) : null}
          <input type="hidden" name="factor_id" value={state.factorId} />
          <Field>
            <Label htmlFor="mfa-code">Authenticator code</Label>
            <Input
              id="mfa-code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
            />
          </Field>
          <SubmitButton pendingLabel="Verifying…">Verify</SubmitButton>
        </>
      )}
    </form>
  );
}
