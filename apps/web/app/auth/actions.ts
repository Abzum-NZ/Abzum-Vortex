"use server";

import {
  completePasswordRecovery,
  confirmEmail as confirmEmailWithAuthority,
  requestPasswordRecovery,
  requestRegistration,
  signInWithPassword,
} from "@vortex/identity";
import { redirect } from "next/navigation";
import { getIdentityJourneyConfiguration } from "./_lib/authority-configuration";

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
  const configuration = configuredAuthority();
  if (!configuration) redirect("/auth/sign-in?status=unavailable");
  const result = await signInWithPassword(
    configuration,
    formValue(formData, "email"),
    formValue(formData, "password", false),
  );

  // The access token is deliberately discarded. Issue #26 owns persistent sessions.
  redirect(
    result.ok
      ? "/auth/success?state=signed-in"
      : `/auth/sign-in?status=${failureStatus(result.code)}`,
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
  if (!configuration || formValue(formData, "type") !== "email")
    redirect("/auth/error?reason=invalid-link");
  const result = await confirmEmailWithAuthority(configuration, formValue(formData, "token_hash"));

  redirect(result.ok ? "/auth/success?state=email-confirmed" : "/auth/error?reason=invalid-link");
}

export async function updatePassword(formData: FormData): Promise<never> {
  const configuration = configuredAuthority();
  if (!configuration) redirect("/auth/error?reason=unavailable");
  const result = await completePasswordRecovery(
    configuration,
    formValue(formData, "token_hash"),
    formValue(formData, "password", false),
  );

  redirect(result.ok ? "/auth/success?state=password-updated" : "/auth/error?reason=invalid-link");
}
