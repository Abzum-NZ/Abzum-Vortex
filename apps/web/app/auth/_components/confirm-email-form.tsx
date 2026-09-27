import { Field } from "@vortex/ui/components/field";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { SubmitButton } from "./submit-button";
import { confirmEmail } from "../actions";

export function ConfirmEmailForm() {
  return (
    <form className="flex flex-col gap-5" action={confirmEmail}>
      <Field>
        <Label htmlFor="email">Email address</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </Field>
      <Field>
        <Label htmlFor="token">Six-digit confirmation code</Label>
        <Input
          id="token"
          name="token"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
        />
      </Field>
      <SubmitButton pendingLabel="Confirming email…">Confirm email address</SubmitButton>
    </form>
  );
}
