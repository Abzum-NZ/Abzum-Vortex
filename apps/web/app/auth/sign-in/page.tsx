import { NavigationLink } from "@vortex/ui/routing";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Separator } from "@vortex/ui/components/separator";
import { AuthForm, AuthTextField } from "../_components/auth-form";
import { AuthShell } from "../_components/auth-shell";
import { PreApplicationStatusNotice } from "../_components/pre-application-status-notice";
import { StatusMessage } from "../_components/status-message";
import { SubmitButton } from "../_components/submit-button";
import { MfaForm } from "../_components/mfa-form";
import { projectPreApplicationStatus } from "../_lib/pre-application-status";
import { identitySessionNavigationHint } from "../_lib/session-request-state";
import { getLocalDevelopmentSignInConfiguration } from "../_lib/authority-configuration";
import { readMfaFactor } from "../_lib/session-server";
import {
  signInContinuationAddressPath,
  parseSignInContinuation,
  serializeSignInContinuation,
} from "../_lib/sign-in-continuation";
import { signIn, signInWithDevelopmentAccount } from "../actions";

type SignInPageProps = Readonly<{
  searchParams: Promise<{ status?: string; mfa?: string; continuation?: unknown }>;
}>;

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const [{ status, mfa, continuation: continuationValue }, requestHeaders] = await Promise.all([
    searchParams,
    headers(),
  ]);
  const continuation = parseSignInContinuation(continuationValue);
  const localDevelopmentSignInEnabled = getLocalDevelopmentSignInConfiguration() !== undefined;
  let sessionState: ReturnType<typeof identitySessionNavigationHint> = "temporarily_unavailable";
  try {
    sessionState = identitySessionNavigationHint(requestHeaders);
  } catch {
    // A failed status read is not sufficient evidence to enter the sign-in form.
  }
  if (sessionState === "verified" && mfa === "1") {
    const factor = await readMfaFactor();
    return (
      <AuthShell
        eyebrow="Account access"
        title="Two-step verification"
        description="Use your authenticator app to verify this session."
      >
        {factor.kind === "unavailable" ? (
          <p role="alert">Two-step verification is temporarily unavailable. Please try again.</p>
        ) : (
          <MfaForm
            initial={factor}
            {...(continuation === undefined
              ? {}
              : { continuation: serializeSignInContinuation(continuation) })}
          />
        )}
      </AuthShell>
    );
  }
  if (sessionState === "verified")
    redirect(
      continuation === undefined ? "/signed-in" : signInContinuationAddressPath(continuation),
    );
  if (sessionState === "temporarily_unavailable") {
    const projection = projectPreApplicationStatus(requestHeaders);
    const retryBasePath =
      projection.kind === "catalogue_notice" ? projection.notice.linkBasePath : "/auth/sign-in";
    const retryHref =
      continuation === undefined
        ? retryBasePath
        : retryBasePath +
          "?" +
          new URLSearchParams({
            continuation: serializeSignInContinuation(continuation),
          }).toString();
    const title =
      projection.kind === "catalogue_notice" ? projection.notice.title : "Account access";
    const description =
      projection.kind === "catalogue_notice"
        ? "Review the notice below to retry sign-in."
        : "Review the sign-in status below.";

    return (
      <AuthShell eyebrow="Account access" title={title} description={description}>
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
        <div className="flex w-full flex-wrap justify-between gap-3 text-sm">
          <NavigationLink
            className="font-medium text-foreground underline underline-offset-4 hover:text-primary transition-colors"
            href="/auth/register"
          >
            Create account
          </NavigationLink>
          <NavigationLink
            className="font-medium text-foreground underline underline-offset-4 hover:text-primary transition-colors"
            href="/auth/recover"
          >
            Forgot password?
          </NavigationLink>
        </div>
      }
    >
      <StatusMessage status={status} />
      <AuthForm action={signIn}>
        {continuation === undefined ? null : (
          <input
            type="hidden"
            name="continuation"
            value={serializeSignInContinuation(continuation)}
          />
        )}
        <AuthTextField
          id="email"
          name="email"
          label="Email address"
          type="email"
          autoComplete="username"
          missing="Enter your email address."
          invalid="Enter an email address like name@example.com."
        />
        <AuthTextField
          id="password"
          name="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          minLength={8}
          missing="Enter your password."
          invalid="Enter your password, at least 8 characters."
        />
        <SubmitButton pendingLabel="Signing in…">Sign in</SubmitButton>
      </AuthForm>
      {localDevelopmentSignInEnabled ? (
        <div className="flex flex-col gap-4 pt-1">
          <div className="relative flex items-center justify-center">
            <Separator />
            <span className="absolute bg-card px-2 text-xs text-muted-foreground uppercase">
              or
            </span>
          </div>
          <form className="flex flex-col gap-3" action={signInWithDevelopmentAccount}>
            {continuation === undefined ? null : (
              <input
                type="hidden"
                name="continuation"
                value={serializeSignInContinuation(continuation)}
              />
            )}
            <SubmitButton variant="outline" pendingLabel="Signing in…">
              Continue with local development account
            </SubmitButton>
          </form>
        </div>
      ) : null}
    </AuthShell>
  );
}
