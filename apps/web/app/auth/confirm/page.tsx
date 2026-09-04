import { AuthShell } from "../_components/auth-shell";
import { ConfirmEmailForm } from "../_components/confirm-email-form";

export default function ConfirmEmailPage() {
  return (
    <AuthShell
      eyebrow="Email confirmation"
      title="Confirming your email address"
      description="Please wait while we verify your one-time confirmation link."
    >
      <ConfirmEmailForm />
    </AuthShell>
  );
}
