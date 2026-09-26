import Link from "next/link";
import { AuthShell } from "../_components/auth-shell";

export default function AuthErrorPage() {
  return (
    <AuthShell
      eyebrow="Unable to continue"
      title="Request a new link"
      description="This link is invalid or has expired. Start again to receive a fresh link."
      footer={
        <Link className="font-medium underline underline-offset-4" href="/auth/sign-in">
          Return to sign in
        </Link>
      }
    >
      <div className="flex flex-col gap-4">
        <div
          className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-2xl font-semibold text-destructive"
          aria-hidden="true"
        >
          !
        </div>
        <div className="flex flex-wrap justify-between gap-3">
          <Link className="font-medium underline underline-offset-4" href="/auth/register">
            Create account
          </Link>
          <Link className="font-medium underline underline-offset-4" href="/auth/recover">
            Recover password
          </Link>
        </div>
      </div>
    </AuthShell>
  );
}
