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
          ? "If the address is connected to an account, a password recovery link is on its way."
          : "Open the confirmation link we sent before signing in."
      }
      footer={
        <Link className="font-medium underline underline-offset-4" href="/auth/sign-in">
          Return to sign in
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
