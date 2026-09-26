import Link from "next/link";
import { AuthShell } from "../_components/auth-shell";

type SuccessPageProps = Readonly<{ searchParams: Promise<{ state?: string }> }>;

export default async function SuccessPage({ searchParams }: SuccessPageProps) {
  const { state } = await searchParams;
  const passwordUpdated = state === "password-updated";

  return (
    <AuthShell
      eyebrow="Complete"
      title={passwordUpdated ? "Password updated" : "Email confirmed"}
      description={
        passwordUpdated
          ? "Your new password is ready to use."
          : "Your email address has been confirmed. You can now sign in."
      }
      footer={
        <Link className="font-medium underline underline-offset-4" href="/auth/sign-in">
          Continue to sign in
        </Link>
      }
    >
      <div
        className="flex size-12 items-center justify-center rounded-full bg-primary text-2xl font-semibold text-primary-foreground"
        aria-hidden="true"
      >
        ✓
      </div>
    </AuthShell>
  );
}
