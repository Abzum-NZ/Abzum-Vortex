"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { confirmEmail } from "../actions";

export function ConfirmEmailForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const submitted = useRef(false);
  const [invalidLink, setInvalidLink] = useState(false);

  useEffect(() => {
    if (submitted.current) return;
    const values = new URLSearchParams(window.location.hash.slice(1));
    const tokenHash = values.get("token_hash") ?? "";
    const type = values.get("type") ?? "";
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    if (tokenHash.length < 16 || type !== "email") {
      setInvalidLink(true);
      return;
    }

    const form = formRef.current;
    if (!form) return;
    submitted.current = true;
    const tokenInput = form.elements.namedItem("token_hash");
    const typeInput = form.elements.namedItem("type");
    if (!(tokenInput instanceof HTMLInputElement) || !(typeInput instanceof HTMLInputElement)) {
      setInvalidLink(true);
      return;
    }
    tokenInput.value = tokenHash;
    typeInput.value = type;
    form.requestSubmit();
  }, []);

  return (
    <>
      <form ref={formRef} action={confirmEmail} hidden>
        <input name="token_hash" type="hidden" />
        <input name="type" type="hidden" />
      </form>
      {invalidLink ? (
        <div className="auth-status auth-status--error" role="alert">
          <p>This confirmation link is incomplete or has expired.</p>
          <Link href="/auth/register">Create a new account</Link>
        </div>
      ) : (
        <p className="auth-hint" role="status">
          Checking your confirmation link…
        </p>
      )}
    </>
  );
}
