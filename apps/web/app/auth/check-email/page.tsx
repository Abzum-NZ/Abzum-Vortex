import Link from "next/link";
import { AuthShell } from "../_components/auth-shell";

type CheckEmailPageProps = Readonly<{
  searchParams: Promise<{ purpose?: string }>;
}>;

export default async function CheckEmailPage({ searchParams }: CheckEmailPageProps) {
  const { purpose } = await searchParams;
  const isRecovery = purpose === "recovery";

  return (
    <AuthShell
      eyebrow={isRecovery ? "Recovery requested" : "Confirm your email"}
      title="Check your inbox"
      description={
        isRecovery
          ? "If the address is connected to an account, a one-time recovery code and instructions are on their way."
          : "Enter the email address and six-digit code from your confirmation message before signing in."
      }
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
      <div className="flex flex-col items-center justify-center py-2">
        <div
          className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary"
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
            <rect width="20" height="16" x="2" y="4" rx="2" />
            <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L1 7" />
          </svg>
        </div>
      </div>
    </AuthShell>
  );
}
