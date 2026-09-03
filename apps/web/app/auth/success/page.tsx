import Link from "next/link";
import { AuthShell } from "../_components/auth-shell";

type SuccessPageProps = Readonly<{ searchParams: Promise<{ state?: string }> }>;

export default async function SuccessPage({ searchParams }: SuccessPageProps) {
  const { state } = await searchParams;
  const passwordUpdated = state === "password-updated";
  const signedIn = state === "signed-in";

  return (
    <AuthShell
      eyebrow="Complete"
      title={
        signedIn ? "Identity verified" : passwordUpdated ? "Password updated" : "Email confirmed"
      }
      description={
        signedIn
          ? "Your identity was verified. Persistent sessions and organisation access are added in the next platform step."
          : passwordUpdated
            ? "Your new password is ready to use."
            : "Your email address has been confirmed. You can now sign in."
      }
      footer={<Link href="/auth/sign-in">Continue to sign in</Link>}
    >
      <div className="auth-state-mark" aria-hidden="true">
        ✓
      </div>
    </AuthShell>
  );
}
