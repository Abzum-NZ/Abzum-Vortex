import { NavigationLink } from "@vortex/ui/routing";
import { AuthForm, AuthTextField } from "../_components/auth-form";
import { AuthShell } from "../_components/auth-shell";
import { StatusMessage } from "../_components/status-message";
import { SubmitButton } from "../_components/submit-button";
import { requestRecovery } from "../actions";

type RecoverPageProps = Readonly<{ searchParams: Promise<{ status?: string }> }>;

export default async function RecoverPage({ searchParams }: RecoverPageProps) {
  const { status } = await searchParams;

  return (
    <AuthShell
      eyebrow="Password recovery"
      title="Reset your password"
      description="Enter your email address. If it is connected to an account, a one-time recovery code and instructions will be sent."
      footer={
        <div className="text-center text-sm">
          <NavigationLink
            className="font-medium text-foreground underline underline-offset-4 hover:text-primary transition-colors"
            href="/auth/sign-in"
          >
            Return to sign in
          </NavigationLink>
        </div>
      }
    >
      <StatusMessage status={status} />
      <AuthForm action={requestRecovery}>
        <AuthTextField
          id="email"
          name="email"
          label="Email address"
          type="email"
          autoComplete="email"
          missing="Enter your email address."
          invalid="Enter an email address like name@example.com."
        />
        <SubmitButton pendingLabel="Requesting code…">Send recovery code</SubmitButton>
      </AuthForm>
    </AuthShell>
  );
}
