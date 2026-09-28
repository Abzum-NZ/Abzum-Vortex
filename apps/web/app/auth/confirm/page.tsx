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
        <Link className="font-medium underline underline-offset-4" href="/auth/sign-in">
          Return to sign in
        </Link>
      }
    >
      <ConfirmEmailForm />
    </AuthShell>
  );
}
