"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AuthShell } from "../_components/auth-shell";
import { SubmitButton } from "../_components/submit-button";
import { updatePassword } from "../actions";

export default function UpdatePasswordPage() {
  const [tokenHash, setTokenHash] = useState("");
  const [checkedLink, setCheckedLink] = useState(false);

  useEffect(() => {
    const values = new URLSearchParams(window.location.hash.slice(1));
    const nextTokenHash = values.get("token_hash") ?? "";
    const type = values.get("type") ?? "";
    if (nextTokenHash.length >= 16 && type === "recovery") setTokenHash(nextTokenHash);
    setCheckedLink(true);
  }, []);

  const validLink = tokenHash.length >= 16;

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
        <input name="token_hash" type="hidden" value={tokenHash} readOnly />
        <label htmlFor="password">New password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
        />
        <p className="auth-hint">Use at least 8 characters.</p>
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
