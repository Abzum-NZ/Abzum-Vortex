import Link from "next/link";
import { AuthShell } from "../_components/auth-shell";

export default function AuthErrorPage() {
  return (
    <AuthShell
      eyebrow="Unable to continue"
      title="Request a new link"
      description="This link is invalid or has expired. Start again to receive a fresh link."
      footer={<Link href="/auth/sign-in">Return to sign in</Link>}
    >
      <div className="auth-state-mark auth-state-mark-error" aria-hidden="true">
        !
      </div>
      <div className="auth-choice-links">
        <Link href="/auth/register">Create account</Link>
        <Link href="/auth/recover">Recover password</Link>
      </div>
    </AuthShell>
  );
}
