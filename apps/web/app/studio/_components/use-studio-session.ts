"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { describeFailure } from "@vortex/platform/schema";
import { z } from "zod";

const sessionResultSchema = z.object({ kind: z.string() }).strict();

export function useStudioSession() {
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef<((signedIn: boolean) => void) | null>(null);
  const request = useRef<Promise<string> | null>(null);
  const saving = useRef(false);
  const mounted = useRef(false);

  const readSession = useCallback((method: "GET" | "POST"): Promise<string> => {
    if (request.current !== null) return request.current;
    const run = (async () => {
      try {
        const response = await fetch("/auth/session", { method, cache: "no-store" });
        return sessionResultSchema.parse(await response.json()).kind;
      } catch (error) {
        console.error("[studio] session refresh failed", describeFailure(error));
        return "temporarily_unavailable";
      } finally {
        request.current = null;
      }
    })();
    request.current = run;
    return run;
  }, []);

  useEffect(() => {
    mounted.current = true;
    // createServerClient deliberately disables auto refresh: keep HttpOnly sessions alive
    // through the existing proxy, including when a suspended tab becomes visible again.
    const keepAlive = () => {
      if (!document.hidden && !saving.current && pending.current === null) void readSession("GET");
    };
    const timer = setInterval(keepAlive, 30_000);
    window.addEventListener("focus", keepAlive);
    document.addEventListener("visibilitychange", keepAlive);
    keepAlive();
    return () => {
      mounted.current = false;
      clearInterval(timer);
      window.removeEventListener("focus", keepAlive);
      document.removeEventListener("visibilitychange", keepAlive);
      pending.current?.(false);
      pending.current = null;
    };
  }, [readSession]);

  const save = useCallback(
    async <Result extends { kind: string; reason?: string }>(
      submit: () => Promise<Result>,
    ): Promise<Result> => {
      saving.current = true;
      try {
        if (request.current !== null) await request.current;
        const result = await submit();
        if (
          result.kind !== "refused" ||
          !["session_ended", "context_changed", "recent_authentication_required"].includes(
            result.reason ?? "",
          ) ||
          !mounted.current
        )
          return result;
        if ((await readSession("POST")) === "active") return await submit();
        if (!mounted.current) return result;
        setNeedsSignIn(true);
        setMessage("");
        const signedIn = await new Promise<boolean>((resolve) => {
          pending.current = resolve;
        });
        return signedIn && mounted.current ? await submit() : result;
      } finally {
        saving.current = false;
      }
    },
    [readSession],
  );

  const returning = useRef(false);
  useEffect(() => {
    const resume = async () => {
      if (!returning.current || document.hidden) return;
      returning.current = false;
      setSigningIn(true);
      try {
        if ((await readSession("POST")) === "active") {
          setNeedsSignIn(false);
          pending.current?.(true);
          pending.current = null;
        } else setMessage("Sign-in has not finished. Your change is kept here; sign in again.");
      } finally {
        if (mounted.current) setSigningIn(false);
      }
    };
    window.addEventListener("focus", resume);
    return () => window.removeEventListener("focus", resume);
  }, [readSession]);
  const openSignIn = useCallback(() => {
    returning.current = true;
    window.open("/auth/sign-in", "_blank", "noopener");
  }, []);
  const cancel = useCallback(() => {
    returning.current = false;
    setNeedsSignIn(false);
    pending.current?.(false);
    pending.current = null;
  }, []);
  return { save, needsSignIn, signingIn, message, openSignIn, cancel };
}
