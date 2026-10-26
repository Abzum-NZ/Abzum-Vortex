"use server";

import {
  completePasswordRecovery,
  confirmEmail as confirmEmailWithAuthority,
  requestPasswordRecovery,
  requestRegistration,
  signInWithLocalDevelopmentAccount,
  signInWithPassword,
} from "@vortex/platform/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  getIdentityJourneyConfiguration,
  getLocalDevelopmentSignInConfiguration,
} from "./_lib/authority-configuration";
import {
  signInContinuationAddressPath,
  parseSingleSignInContinuation,
  serializeSignInContinuation,
  type SignInContinuation,
} from "./_lib/sign-in-continuation";
import { bootstrapIdentitySession, endIdentitySession } from "./_lib/session-server";

const formValue = (formData: FormData, name: string, trim = true): string => {
  const value = formData.get(name);
  if (typeof value !== "string") return "";
  return trim ? value.trim() : value;
};

const failureStatus = (code: string): string => {
  if (code === "vortex.identity.privacy_notice_required") return "privacy_notice_required";
  if (code === "vortex.identity.privacy_notice_changed") return "privacy_notice_changed";
  if (code === "vortex.identity.registration_closed") return "registration_closed";
  if (code === "vortex.identity.invalid_credentials") return "invalid_credentials";
  if (code === "vortex.identity.invalid_or_expired_link") return "invalid_link";
  if (code === "vortex.identity.authority_unavailable") return "unavailable";
  return "invalid";
};

const configuredAuthority = () => {
  try {
    return getIdentityJourneyConfiguration();
  } catch {
    return undefined;
  }
};

const signInStatusPath = (status: string, continuation: SignInContinuation | undefined): string => {
  const query = new URLSearchParams({ status });
  if (continuation !== undefined)
    query.set("continuation", serializeSignInContinuation(continuation));
  return `/auth/sign-in?${query.toString()}`;
};

export async function register(formData: FormData): Promise<never> {
  const configuration = configuredAuthority();
  if (!configuration) redirect("/auth/register?status=unavailable");
  const result = await requestRegistration(
    configuration,
    formValue(formData, "email"),
    formValue(formData, "password", false),
    {
      acknowledged:
        formData.getAll("privacy_notice_acknowledged").length === 1 &&
        formData.get("privacy_notice_acknowledged") === "on",
      noticeVersionId: formValue(formData, "notice_version_id"),
    },
  );

  redirect(
    result.ok
      ? "/auth/check-email?purpose=confirmation"
      : `/auth/register?status=${failureStatus(result.code)}`,
  );
}

export async function signIn(formData: FormData): Promise<never> {
  const continuation = parseSingleSignInContinuation(formData.getAll("continuation"));
  const configuration = configuredAuthority();
  if (!configuration) redirect(signInStatusPath("unavailable", continuation));
  const result = await signInWithPassword(
    configuration,
    formValue(formData, "email"),
    formValue(formData, "password", false),
  );

  const session = result.ok ? await bootstrapIdentitySession(result) : undefined;
  redirect(
    result.ok && session?.kind === "active"
      ? continuation === undefined
        ? "/signed-in"
        : signInContinuationAddressPath(continuation)
      : signInStatusPath(result.ok ? "unavailable" : failureStatus(result.code), continuation),
  );
}

export async function signOut(): Promise<never> {
  await endIdentitySession();
  redirect("/auth/sign-in?status=signed-out");
}

export async function signInWithDevelopmentAccount(formData: FormData): Promise<never> {
  const continuation = parseSingleSignInContinuation(formData.getAll("continuation"));
  const configuration = getLocalDevelopmentSignInConfiguration();
  if (!configuration) redirect(signInStatusPath("unavailable", continuation));
  const requestHeaders = await headers();
  const site = new URL(configuration.journey.siteUrl);
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  if (
    requestHeaders.get("origin") !== site.origin ||
    requestHeaders.get("host") !== site.host ||
    (forwardedProtocol !== null && forwardedProtocol !== "http")
  )
    redirect(signInStatusPath("unavailable", continuation));

  const result = await signInWithLocalDevelopmentAccount(configuration);
  const session = result.ok ? await bootstrapIdentitySession(result) : undefined;
  redirect(
    result.ok && session?.kind === "active"
      ? continuation === undefined
        ? "/signed-in"
        : signInContinuationAddressPath(continuation)
      : signInStatusPath("unavailable", continuation),
  );
}

export async function requestRecovery(formData: FormData): Promise<never> {
  const configuration = configuredAuthority();
  if (!configuration) redirect("/auth/recover?status=unavailable");
  const result = await requestPasswordRecovery(configuration, formValue(formData, "email"));

  redirect(
    result.ok
      ? "/auth/check-email?purpose=recovery"
      : `/auth/recover?status=${failureStatus(result.code)}`,
  );
}

export async function confirmEmail(formData: FormData): Promise<never> {
  const configuration = configuredAuthority();
  if (!configuration) redirect("/auth/error?reason=invalid-link");
  const result = await confirmEmailWithAuthority(
    configuration,
    formValue(formData, "email"),
    formValue(formData, "token"),
  );

  redirect(result.ok ? "/auth/success?state=email-confirmed" : "/auth/error?reason=invalid-link");
}

export async function updatePassword(formData: FormData): Promise<never> {
  const configuration = configuredAuthority();
  if (!configuration) redirect("/auth/error?reason=unavailable");
  const result = await completePasswordRecovery(
    configuration,
    formValue(formData, "email"),
    formValue(formData, "token"),
    formValue(formData, "password", false),
  );

  redirect(result.ok ? "/auth/success?state=password-updated" : "/auth/error?reason=invalid-link");
}
