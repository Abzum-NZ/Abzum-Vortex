"use client";

import { useActionState, useState } from "react";
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
  const [enrolment, setEnrolment] = useState<{ secret: string; qrCode: string }>();
  const [state, action] = useActionState(
    async (previous: MfaFormState, formData: FormData): Promise<MfaFormState> => {
      const result = await completeMfa(formData);
      if (result.kind === "error") return { ...previous, error: result.error };
      setEnrolment({ secret: result.secret, qrCode: result.qrCode });
      return { kind: "enrolled", factorId: result.factorId };
    },
    initial,
  );
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
          {state.kind === "enrolled" && enrolment !== undefined ? (
            <div className="flex flex-col items-start gap-3">
              <FieldDescription>
                Scan this QR code with your authenticator app, then enter the code it shows.
              </FieldDescription>
              {/* The QR code is an SVG data address from the identity provider, shown as an image. */}
              <img
                src={enrolment.qrCode}
                alt="QR code for your authenticator app"
                width={176}
                height={176}
                className="rounded-md border bg-white p-2"
              />
              <FieldDescription>
                If you cannot scan it, add the account with this setup key:{" "}
                <code className="break-all">{enrolment.secret}</code>
              </FieldDescription>
            </div>
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
