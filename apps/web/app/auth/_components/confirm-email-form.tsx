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
    const fragment = window.location.hash;
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    const values = new URLSearchParams(fragment.slice(1));
    const accessToken = values.get("access_token") ?? "";
    const type = values.get("type") ?? "";
    if (values.has("error") || accessToken.length < 64 || type !== "signup") {
      setInvalidLink(true);
      return;
    }

    const form = formRef.current;
    if (!form) return;
    submitted.current = true;
    const tokenInput = form.elements.namedItem("access_token");
    const typeInput = form.elements.namedItem("type");
    if (!(tokenInput instanceof HTMLInputElement) || !(typeInput instanceof HTMLInputElement)) {
      setInvalidLink(true);
      return;
    }
    tokenInput.value = accessToken;
    typeInput.value = type;
    form.requestSubmit();
  }, []);

  return (
    <>
      <form ref={formRef} action={confirmEmail} hidden>
        <input name="access_token" type="hidden" />
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
