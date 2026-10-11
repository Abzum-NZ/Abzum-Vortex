import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Field } from "@vortex/ui/components/field";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { AuthShell } from "../_components/auth-shell";
import { PreApplicationStatusNotice } from "../_components/pre-application-status-notice";
import { StatusMessage } from "../_components/status-message";
import { SubmitButton } from "../_components/submit-button";
import { projectPreApplicationStatus } from "../_lib/pre-application-status";
import { identitySessionNavigationHint } from "../_lib/session-request-state";
import { getLocalDevelopmentSignInConfiguration } from "../_lib/authority-configuration";
import {
  applicationHomeAddressPath,
  parseApplicationHomeContinuation,
  serializeApplicationHomeContinuation,
} from "../_lib/application-home-continuation";
import { signIn, signInWithDevelopmentAccount } from "../actions";

type SignInPageProps = Readonly<{
  searchParams: Promise<{ status?: string; applicationHome?: unknown }>;
}>;

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const [{ status, applicationHome: applicationHomeValue }, requestHeaders] = await Promise.all([
    searchParams,
    headers(),
  ]);
  const applicationHome = parseApplicationHomeContinuation(applicationHomeValue);
  const localDevelopmentSignInEnabled = getLocalDevelopmentSignInConfiguration() !== undefined;
  let sessionState: ReturnType<typeof identitySessionNavigationHint> = "temporarily_unavailable";
  try {
    sessionState = identitySessionNavigationHint(requestHeaders);
  } catch {
    // A failed status read is not sufficient evidence to enter the sign-in form.
  }
  if (sessionState === "verified")
    redirect(
      applicationHome === undefined
        ? "/signed-in"
        : applicationHomeAddressPath(applicationHome),
    );
  if (sessionState === "temporarily_unavailable") {
    const projection = projectPreApplicationStatus(requestHeaders);
    const retryBasePath =
      projection.kind === "catalogue_notice"
        ? projection.notice.linkBasePath
        : "/auth/sign-in";
    const retryHref =
      applicationHome === undefined
        ? retryBasePath
        : retryBasePath +
          "?" +
          new URLSearchParams({
            applicationHome: serializeApplicationHomeContinuation(applicationHome),
          }).toString();
    const title =
      projection.kind === "catalogue_notice" ? projection.notice.title : "Account access";
    const description =
      projection.kind === "catalogue_notice"
        ? "Review the notice below to retry sign-in."
        : "Review the sign-in status below.";

    return (
      <AuthShell
        eyebrow="Account access"
        title={title}
        description={description}
      >
        <PreApplicationStatusNotice projection={projection} retryHref={retryHref} />
      </AuthShell>
    );
  }

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
      {localDevelopmentSignInEnabled ? (
        <form className="mt-5 flex flex-col gap-3" action={signInWithDevelopmentAccount}>
          {applicationHome === undefined ? null : (
            <input
              type="hidden"
              name="applicationHome"
              value={serializeApplicationHomeContinuation(applicationHome)}
            />
          )}
          <SubmitButton pendingLabel="Signing in…">
            Continue with local development account
          </SubmitButton>
        </form>
      ) : null}
    </AuthShell>
  );
}
