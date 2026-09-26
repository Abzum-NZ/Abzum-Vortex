"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
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
        <Alert variant="destructive">
          <AlertDescription>
            <p>This confirmation link is incomplete or has expired.</p>
            <Link className="font-medium underline underline-offset-4" href="/auth/register">
              Create a new account
            </Link>
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-sm text-muted-foreground" role="status">
          Checking your confirmation link…
        </p>
      )}
    </>
  );
}
