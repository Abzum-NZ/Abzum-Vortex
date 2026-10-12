import Link from "next/link";
import { AuthShell } from "../_components/auth-shell";
import { ConfirmEmailForm } from "../_components/confirm-email-form";

export default function ConfirmEmailPage() {
  return (
    <AuthShell
      eyebrow="Email confirmation"
      title="Confirm your email address"
      description="Enter the email address and six-digit code from your confirmation message. Opening this page does not confirm your address."
      footer={
        <div className="text-center text-sm">
          <Link
            className="font-medium text-foreground underline underline-offset-4 hover:text-primary transition-colors"
            href="/auth/sign-in"
          >
            Return to sign in
          </Link>
        </div>
      }
    >
      <ConfirmEmailForm />
    </AuthShell>
  );
}
