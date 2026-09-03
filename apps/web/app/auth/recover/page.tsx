import Link from "next/link";
import { AuthShell } from "../_components/auth-shell";
import { StatusMessage } from "../_components/status-message";
import { SubmitButton } from "../_components/submit-button";
import { requestRecovery } from "../actions";

type RecoverPageProps = Readonly<{ searchParams: Promise<{ status?: string }> }>;

export default async function RecoverPage({ searchParams }: RecoverPageProps) {
  const { status } = await searchParams;

  return (
    <AuthShell
      eyebrow="Password recovery"
      title="Reset your password"
      description="Enter your email address. If it is connected to an account, a recovery link will be sent."
      footer={<Link href="/auth/sign-in">Return to sign in</Link>}
    >
      <StatusMessage status={status} />
      <form className="auth-form" action={requestRecovery}>
        <label htmlFor="email">Email address</label>
        <input id="email" name="email" type="email" autoComplete="email" required />
        <SubmitButton pendingLabel="Requesting link…">Send recovery link</SubmitButton>
      </form>
    </AuthShell>
  );
}
