import Link from "next/link";
import { Icon } from "@vortex/ui/icons";
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
        <Link className="font-medium underline underline-offset-4" href="/auth/sign-in">
          Return to sign in
        </Link>
      }
    >
      <div
        className="flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground"
        aria-hidden="true"
      >
        <Icon name="check" className="size-6" />
      </div>
    </AuthShell>
  );
}
