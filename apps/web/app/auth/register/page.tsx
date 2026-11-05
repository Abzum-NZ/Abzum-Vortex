import { NavigationLink } from "@vortex/ui/routing";
import { newPasswordPolicy, readPrivacyNotice } from "@vortex/platform/server";
import { AuthCheckbox, AuthForm, AuthTextField } from "../_components/auth-form";
import { AuthShell } from "../_components/auth-shell";
import { StatusMessage } from "../_components/status-message";
import { SubmitButton } from "../_components/submit-button";
import { register } from "../actions";

type RegisterPageProps = Readonly<{ searchParams: Promise<{ status?: string }> }>;

export default async function RegisterPage({ searchParams }: RegisterPageProps) {
  const { status } = await searchParams;
  // No notice in effect means registration is not open; any other failure reaches the error page.
  const notice = await readPrivacyNotice();

  return (
    <AuthShell
      eyebrow="Create account"
      title="Start with your email"
      description="Use an email address you can verify. You will receive a one-time confirmation code before you can sign in."
      footer={
        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <NavigationLink
            className="font-medium text-foreground underline underline-offset-4 hover:text-primary transition-colors"
            href="/auth/sign-in"
          >
            Sign in
          </NavigationLink>
        </p>
      }
    >
      <StatusMessage status={notice === undefined ? "registration_closed" : status} />
      {notice !== undefined && status === "invalid_password" ? (
        <p role="alert" className="text-sm text-destructive">
          {newPasswordPolicy.description}
        </p>
      ) : null}
      {notice !== undefined && (
        <AuthForm action={register}>
          <p className="text-sm text-muted-foreground">
            {notice.content.collectionNotice}{" "}
            <NavigationLink className="underline underline-offset-4" href={notice.locator}>
              Privacy Policy
            </NavigationLink>
          </p>
          <input type="hidden" name="notice_version_id" value={notice.id} />
          <AuthTextField
            id="email"
            name="email"
            label="Email address"
            type="email"
            autoComplete="email"
            missing="Enter your email address."
            invalid="Enter an email address like name@example.com."
          />
          <AuthTextField
            id="password"
            name="password"
            label="Password"
            description={newPasswordPolicy.description}
            type="password"
            autoComplete="new-password"
            minLength={newPasswordPolicy.minimumLength}
            maxLength={newPasswordPolicy.maximumLength}
            pattern={newPasswordPolicy.pattern}
            missing="Choose a password."
            invalid={newPasswordPolicy.description}
          />
          <AuthCheckbox
            id="privacy-notice"
            name="privacy_notice_acknowledged"
            label="I acknowledge the Privacy Policy."
            missing="Acknowledge the Privacy Policy to create your account."
          />
          <SubmitButton pendingLabel="Creating account…">Create account</SubmitButton>
        </AuthForm>
      )}
    </AuthShell>
  );
}
