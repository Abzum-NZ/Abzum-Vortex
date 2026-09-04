"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AuthShell } from "../_components/auth-shell";
import { SubmitButton } from "../_components/submit-button";
import { updatePassword } from "../actions";

export default function UpdatePasswordPage() {
  const [tokens, setTokens] = useState({ accessToken: "", refreshToken: "" });
  const [checkedLink, setCheckedLink] = useState(false);

  useEffect(() => {
    const fragment = window.location.hash;
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    const values = new URLSearchParams(fragment.slice(1));
    const accessToken = values.get("access_token") ?? "";
    const refreshToken = values.get("refresh_token") ?? "";
    const type = values.get("type") ?? "";
    if (
      !values.has("error") &&
      accessToken.length >= 64 &&
      refreshToken.length > 0 &&
      type === "recovery"
    )
      setTokens({ accessToken, refreshToken });
    setCheckedLink(true);
  }, []);

  const validLink = tokens.accessToken.length >= 64 && tokens.refreshToken.length > 0;

  return (
    <AuthShell
      eyebrow="Password recovery"
      title={
        !checkedLink
          ? "Checking your recovery link"
          : validLink
            ? "Choose a new password"
            : "Recovery link unavailable"
      }
      description={
        !checkedLink
          ? "Please wait while we check your one-time recovery link."
          : validLink
            ? "Set a new password for your account. The recovery link can be used only once."
            : "This recovery link is incomplete or has expired. Request a new link to continue."
      }
    >
      <form className="auth-form" action={updatePassword} hidden={!validLink}>
        <input name="access_token" type="hidden" value={tokens.accessToken} readOnly />
        <input name="refresh_token" type="hidden" value={tokens.refreshToken} readOnly />
        <label htmlFor="password">New password</label>
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
        <SubmitButton pendingLabel="Updating password…">Update password</SubmitButton>
      </form>
      {!checkedLink ? (
        <p className="auth-hint" role="status">
          Checking your recovery link…
        </p>
      ) : !validLink ? (
        <Link className="auth-submit" href="/auth/recover">
          <span>Request a new link</span>
          <span aria-hidden="true">→</span>
        </Link>
      ) : null}
    </AuthShell>
  );
}
