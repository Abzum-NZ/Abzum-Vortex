import Link from "next/link";
import { AuthShell } from "../_components/auth-shell";
import { StatusMessage } from "../_components/status-message";
import { SubmitButton } from "../_components/submit-button";
import { signIn } from "../actions";

type SignInPageProps = Readonly<{ searchParams: Promise<{ status?: string }> }>;

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const { status } = await searchParams;

  return (
    <AuthShell
      eyebrow="Account access"
      title="Sign in"
      description="Enter the email address and password connected to your Vortex identity."
      footer={
        <div className="auth-footer-links">
          <Link href="/auth/register">Create account</Link>
          <Link href="/auth/recover">Forgot password?</Link>
        </div>
      }
    >
      <StatusMessage status={status} />
      <form className="auth-form" action={signIn}>
        <label htmlFor="email">Email address</label>
        <input id="email" name="email" type="email" autoComplete="email" required />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          minLength={8}
          required
        />
        <SubmitButton pendingLabel="Signing in…">Sign in</SubmitButton>
      </form>
    </AuthShell>
  );
}
