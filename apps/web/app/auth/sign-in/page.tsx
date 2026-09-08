import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthShell } from "../_components/auth-shell";
import { StatusMessage } from "../_components/status-message";
import { SubmitButton } from "../_components/submit-button";
import { identitySessionNavigationHint } from "../_lib/session-request-state";
import { signIn } from "../actions";

type SignInPageProps = Readonly<{ searchParams: Promise<{ status?: string }> }>;

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const [{ status }, requestHeaders] = await Promise.all([searchParams, headers()]);
  const sessionState = identitySessionNavigationHint(requestHeaders);
  if (sessionState === "verified") redirect("/signed-in");
  if (sessionState === "temporarily_unavailable")
    return (
      <AuthShell
        eyebrow="Account access"
        title="Account access is temporarily unavailable"
        description="Vortex could not confirm this browser session right now. Try again to continue."
      >
        <a href="/auth/sign-in">Try again</a>
      </AuthShell>
    );

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
