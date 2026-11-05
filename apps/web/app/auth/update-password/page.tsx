import { NavigationLink } from "@vortex/ui/routing";
import { newPasswordPolicy } from "@vortex/platform/server";
import { AuthForm, AuthTextField } from "../_components/auth-form";
import { AuthShell } from "../_components/auth-shell";
import { StatusMessage } from "../_components/status-message";
import { SubmitButton } from "../_components/submit-button";
import { updatePassword } from "../actions";

export default async function UpdatePasswordPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ status?: string }> }>) {
  const { status } = await searchParams;
  return (
    <AuthShell
      eyebrow="Password recovery"
      title="Choose a new password"
      description="Enter the email address and six-digit recovery code from your message, then choose a new password. Opening this page does not change your password."
      footer={
        <div className="text-center text-sm">
          <NavigationLink
            className="font-medium text-foreground underline underline-offset-4 hover:text-primary transition-colors"
            href="/auth/recover"
          >
            Request a new recovery code
          </NavigationLink>
        </div>
      }
    >
      <StatusMessage status={status} />
      <AuthForm action={updatePassword}>
        <AuthTextField
          id="email"
          name="email"
          label="Email address"
          type="email"
          autoComplete="username"
          missing="Enter your email address."
          invalid="Enter an email address like name@example.com."
        />
        <AuthTextField
          id="token"
          name="token"
          label="Six-digit recovery code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          missing="Enter the six-digit code."
          invalid="The code is six digits, with no spaces."
        />
        <AuthTextField
          id="password"
          name="password"
          label="New password"
          description={newPasswordPolicy.description}
          type="password"
          autoComplete="new-password"
          minLength={newPasswordPolicy.minimumLength}
          pattern={newPasswordPolicy.pattern}
          missing="Choose a password."
          invalid="This password does not meet the rules above."
        />
        <SubmitButton pendingLabel="Updating password…">Update password</SubmitButton>
      </AuthForm>
    </AuthShell>
  );
}
