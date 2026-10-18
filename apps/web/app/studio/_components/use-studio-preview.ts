"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StudioStoredApplicationDraft } from "@vortex/ui/studio";
import { previewStudioApplication } from "../_lib/studio-read-client";
import type { StudioPreviewStatus } from "../../_lib/studio-application-preview";

type Readiness = Readonly<{ identity: string; status: StudioPreviewStatus }>;
export type StudioPreviewReadiness = Readiness & Readonly<{ refresh: () => void }>;

/** One in-flight preparation per workspace, followed immediately by its newest saved revision. */
export function useStudioPreview(organizationId: string, saved: StudioStoredApplicationDraft): StudioPreviewReadiness {
  const identity = JSON.stringify([organizationId, saved.rootId, saved.draftRevision, saved.sourceFingerprint]);
  const latest = useRef({ identity, rootId: saved.rootId, draftRevision: saved.draftRevision, sourceFingerprint: saved.sourceFingerprint });
  latest.current = { identity, rootId: saved.rootId, draftRevision: saved.draftRevision, sourceFingerprint: saved.sourceFingerprint };
  const running = useRef<Promise<void> | null>(null);
  const completed = useRef<Readiness | null>(null);
  const [readiness, setReadiness] = useState<Readiness>({ identity: "", status: { kind: "preparing" } });
  const [attempt, setAttempt] = useState(0);
  // A read can discover that an otherwise ready preview needs reconciliation or renewal. This
  // starts an explicit preparation, once; a failed/invalid revision is never retried by reads.
  const refresh = useCallback(() => {
    if (completed.current?.identity !== latest.current.identity || completed.current.status.kind !== "ready") return;
    completed.current = null;
    setReadiness({ identity: "", status: { kind: "preparing" } });
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    let active = true;
    const run = async () => {
      // A superseded browser read never cancels the server's preparation/transaction cleanup.
      if (running.current !== null) await running.current;
      if (!active) return;
      if (completed.current?.identity === latest.current.identity) { setReadiness(completed.current); return; }
      const work = (async () => {
        do {
          const target = latest.current;
          const request = { rootId: target.rootId, draftRevision: target.draftRevision };
          let status: StudioPreviewStatus;
          try {
            const query = new URLSearchParams({ organizationId, request: JSON.stringify(request) });
            const observe = async (): Promise<StudioPreviewStatus> => {
              const response = await fetch(`/studio/preview?${query}`, { cache: "no-store", credentials: "same-origin" });
              if (!response.ok) throw new Error(`STUDIO_PREVIEW_STATUS_HTTP_${response.status}`);
              return response.json() as Promise<StudioPreviewStatus>;
            };
            const result = await previewStudioApplication(organizationId, request);
            status = result.kind === "provisioned" ? await observe() : result;
            if (status.kind === "ready" && (status.draftRevision !== target.draftRevision ||
              status.sourceFingerprint !== target.sourceFingerprint)) status = { kind: "conflict" };
          } catch (cause) {
            console.error("[studio] preparing the saved preview failed", cause);
            status = { kind: "temporarily_unavailable" };
          }
          completed.current = { identity: target.identity, status };
          if (active && latest.current.identity === target.identity) setReadiness({ identity: target.identity, status });
        } while (active && completed.current?.identity !== latest.current.identity);
      })();
      running.current = work;
      try { await work; } finally { if (running.current === work) running.current = null; }
    };
    void run();
    return () => { active = false; };
  }, [identity, organizationId, attempt]);

  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  return useMemo(() => ({ ...(readiness.identity === identity ? readiness
    : { identity, status: { kind: "preparing" as const } }), refresh }), [identity, readiness, refresh]);
}
