import Link from "next/link";
import { newPasswordPolicy } from "@vortex/platform/server";
import { Field, FieldDescription } from "@vortex/ui/components/field";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { AuthShell } from "../_components/auth-shell";
import { SubmitButton } from "../_components/submit-button";
import { updatePassword } from "../actions";

export default function UpdatePasswordPage() {
  return (
    <AuthShell
      eyebrow="Password recovery"
      title="Choose a new password"
      description="Enter the email address and six-digit recovery code from your message, then choose a new password. Opening this page does not change your password."
      footer={
        <div className="text-center text-sm">
          <Link
            className="font-medium text-foreground underline underline-offset-4 hover:text-primary transition-colors"
            href="/auth/recover"
          >
            Request a new recovery code
          </Link>
        </div>
      }
    >
      <form className="flex flex-col gap-5" action={updatePassword}>
        <Field>
          <Label htmlFor="email">Email address</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        <Field>
          <Label htmlFor="token">Six-digit recovery code</Label>
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
        <Field>
          <Label htmlFor="password">New password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={newPasswordPolicy.minimumLength}
            pattern={newPasswordPolicy.pattern}
            required
          />
          <FieldDescription>{newPasswordPolicy.description}</FieldDescription>
        </Field>
        <SubmitButton pendingLabel="Updating password…">Update password</SubmitButton>
      </form>
    </AuthShell>
  );
}
