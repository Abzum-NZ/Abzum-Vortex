"use client";

import { startTransition } from "react";
import { AuthenticatorCode, EnrolAuthenticator } from "../../_components/authenticator-proof";
import { finishMfa } from "../actions";

/**
 * The sign-in page's second step: the code from the authenticator the person has, or setting one
 * up. It is the very form a flow's Verify step shows; only what follows differs: here the person
 * goes on to where they were heading.
 */
export function MfaForm({
  initial,
  continuation,
}: {
  initial: { kind: "setup" } | { kind: "challenge"; factorId: string };
  continuation?: string;
}) {
  const done = (): void => {
    startTransition(() => {
      void finishMfa(continuation ?? "");
    });
  };
  return initial.kind === "challenge" ? (
    <AuthenticatorCode factorId={initial.factorId} onVerified={done} />
  ) : (
    <EnrolAuthenticator onVerified={done} />
  );
}
