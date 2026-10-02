import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Field } from "@vortex/ui/components/field";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { AuthShell } from "../_components/auth-shell";
import { StatusMessage } from "../_components/status-message";
import { SubmitButton } from "../_components/submit-button";
import { identitySessionNavigationHint } from "../_lib/session-request-state";
import {
  applicationHomeAddressPath,
  parseApplicationHomeContinuation,
  serializeApplicationHomeContinuation,
} from "../_lib/application-home-continuation";
import { signIn } from "../actions";

type SignInPageProps = Readonly<{
  searchParams: Promise<{ status?: string; applicationHome?: unknown }>;
}>;

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const [{ status, applicationHome: applicationHomeValue }, requestHeaders] = await Promise.all([
    searchParams,
    headers(),
  ]);
  const applicationHome = parseApplicationHomeContinuation(applicationHomeValue);
  const sessionState = identitySessionNavigationHint(requestHeaders);
  if (sessionState === "verified")
    redirect(
      applicationHome === undefined
        ? "/signed-in"
        : applicationHomeAddressPath(applicationHome),
    );
  const retryHref =
    applicationHome === undefined
      ? "/auth/sign-in"
      : `/auth/sign-in?${new URLSearchParams({
          applicationHome: serializeApplicationHomeContinuation(applicationHome),
        }).toString()}`;
  if (sessionState === "temporarily_unavailable")
    return (
      <AuthShell
        eyebrow="Account access"
        title="Account access is temporarily unavailable"
        description="Vortex could not confirm this browser session right now. Try again to continue."
      >
        <a className="font-medium underline underline-offset-4" href={retryHref}>
          Try again
        </a>
      </AuthShell>
    );

  return (
    <AuthShell
      eyebrow="Account access"
      title="Sign in"
      description="Enter the email address and password connected to your Vortex identity."
      footer={
        <div className="flex flex-wrap justify-between gap-3">
          <Link className="font-medium underline underline-offset-4" href="/auth/register">
            Create account
          </Link>
          <Link className="font-medium underline underline-offset-4" href="/auth/recover">
            Forgot password?
          </Link>
        </div>
      }
    >
      <StatusMessage status={status} />
      <form className="flex flex-col gap-5" action={signIn}>
        {applicationHome === undefined ? null : (
          <input
            type="hidden"
            name="applicationHome"
            value={serializeApplicationHomeContinuation(applicationHome)}
          />
        )}
        <Field>
          <Label htmlFor="email">Email address</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        <Field>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            minLength={8}
            required
          />
        </Field>
        <SubmitButton pendingLabel="Signing in…">Sign in</SubmitButton>
      </form>
    </AuthShell>
  );
}
