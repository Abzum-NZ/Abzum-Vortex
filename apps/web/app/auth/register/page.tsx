import Link from "next/link";
import { AuthShell } from "../_components/auth-shell";
import { StatusMessage } from "../_components/status-message";
import { SubmitButton } from "../_components/submit-button";
import { register } from "../actions";

type RegisterPageProps = Readonly<{ searchParams: Promise<{ status?: string }> }>;

export default async function RegisterPage({ searchParams }: RegisterPageProps) {
  const { status } = await searchParams;

  return (
    <AuthShell
      eyebrow="Create account"
      title="Start with your email"
      description="Use an email address you can verify. You will receive a confirmation link before you can sign in."
      footer={
        <p>
          Already have an account? <Link href="/auth/sign-in">Sign in</Link>
        </p>
      }
    >
      <StatusMessage status={status} />
      <form className="auth-form" action={register}>
        <label htmlFor="email">Email address</label>
        <input id="email" name="email" type="email" autoComplete="email" required />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          pattern="(?=.*[A-Za-z])(?=.*\d).{8,1024}"
          required
        />
        <p className="auth-hint">Use at least 8 characters, including a letter and a number.</p>
        <SubmitButton pendingLabel="Creating account…">Create account</SubmitButton>
      </form>
    </AuthShell>
  );
}
