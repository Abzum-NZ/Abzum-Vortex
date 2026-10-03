"use server";

import {
  completePasswordRecovery,
  confirmEmail as confirmEmailWithAuthority,
  requestPasswordRecovery,
  requestRegistration,
  signInWithLocalDevelopmentAccount,
  signInWithPassword,
} from "@vortex/identity";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  getIdentityJourneyConfiguration,
  getLocalDevelopmentSignInConfiguration,
} from "./_lib/authority-configuration";
import {
  applicationHomeAddressPath,
  parseSingleApplicationHomeContinuation,
  serializeApplicationHomeContinuation,
  type ApplicationHomeContinuation,
} from "./_lib/application-home-continuation";
import { bootstrapIdentitySession, endIdentitySession } from "./_lib/session-server";

const formValue = (formData: FormData, name: string, trim = true): string => {
  const value = formData.get(name);
  if (typeof value !== "string") return "";
  return trim ? value.trim() : value;
};

const failureStatus = (code: string): string => {
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

const signInStatusPath = (
  status: string,
  applicationHome: ApplicationHomeContinuation | undefined,
): string => {
  const query = new URLSearchParams({ status });
  if (applicationHome !== undefined)
    query.set("applicationHome", serializeApplicationHomeContinuation(applicationHome));
  return `/auth/sign-in?${query.toString()}`;
};

export async function register(formData: FormData): Promise<never> {
  const configuration = configuredAuthority();
  if (!configuration) redirect("/auth/register?status=unavailable");
  const result = await requestRegistration(
    configuration,
    formValue(formData, "email"),
    formValue(formData, "password", false),
  );

  redirect(
    result.ok
      ? "/auth/check-email?purpose=confirmation"
      : `/auth/register?status=${failureStatus(result.code)}`,
  );
}

export async function signIn(formData: FormData): Promise<never> {
  const applicationHome = parseSingleApplicationHomeContinuation(
    formData.getAll("applicationHome"),
  );
  const configuration = configuredAuthority();
  if (!configuration) redirect(signInStatusPath("unavailable", applicationHome));
  const result = await signInWithPassword(
    configuration,
    formValue(formData, "email"),
    formValue(formData, "password", false),
  );

  const session = result.ok ? await bootstrapIdentitySession(result) : undefined;
  redirect(
    result.ok && session?.kind === "active"
      ? applicationHome === undefined
        ? "/signed-in"
        : applicationHomeAddressPath(applicationHome)
      : signInStatusPath(
          result.ok ? "unavailable" : failureStatus(result.code),
          applicationHome,
        ),
  );
}

export async function signOut(): Promise<never> {
  await endIdentitySession();
  redirect("/auth/sign-in?status=signed-out");
}

export async function signInWithDevelopmentAccount(formData: FormData): Promise<never> {
  const applicationHome = parseSingleApplicationHomeContinuation(
    formData.getAll("applicationHome"),
  );
  const configuration = getLocalDevelopmentSignInConfiguration();
  if (!configuration) redirect(signInStatusPath("unavailable", applicationHome));
  const requestHeaders = await headers();
  const site = new URL(configuration.journey.siteUrl);
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  if (
    requestHeaders.get("origin") !== site.origin ||
    requestHeaders.get("host") !== site.host ||
    (forwardedProtocol !== null && forwardedProtocol !== "http")
  )
    redirect(signInStatusPath("unavailable", applicationHome));

  const result = await signInWithLocalDevelopmentAccount(configuration);
  const session = result.ok ? await bootstrapIdentitySession(result) : undefined;
  redirect(
    result.ok && session?.kind === "active"
      ? applicationHome === undefined
        ? "/signed-in"
        : applicationHomeAddressPath(applicationHome)
      : signInStatusPath("unavailable", applicationHome),
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
