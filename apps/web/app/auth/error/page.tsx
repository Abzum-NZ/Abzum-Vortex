import Link from "next/link";
import { AuthShell } from "../_components/auth-shell";

export default function AuthErrorPage() {
  return (
    <AuthShell
      eyebrow="Unable to continue"
      title="Unable to complete request"
      description="This request could not be completed. Start again to receive a new code."
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
      <div className="flex flex-col items-center gap-6 py-2">
        <div
          className="flex size-14 items-center justify-center rounded-full bg-destructive/10 text-destructive"
          aria-hidden="true"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-7"
          >
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <div className="flex w-full flex-wrap justify-between gap-3 text-sm">
          <Link
            className="font-medium text-foreground underline underline-offset-4 hover:text-primary transition-colors"
            href="/auth/register"
          >
            Create account
          </Link>
          <Link
            className="font-medium text-foreground underline underline-offset-4 hover:text-primary transition-colors"
            href="/auth/recover"
          >
            Recover password
          </Link>
        </div>
      </div>
    </AuthShell>
  );
}
