"use client";
import { useEffect, useState } from "react";
import type { StudioApplicationHistoryPage } from "../../_lib/studio-application-history";
import { listApplicationReleaseHistory } from "../releases-actions";
import { unavailableMessage, type StudioUnavailableKind } from "./studio-refusal-messages";
import { ApplicationReleaseHistory } from "./application-release-history";

type HistoryLoad =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "available"; page: StudioApplicationHistoryPage }>
  | Readonly<{ kind: "unavailable"; failure: StudioUnavailableKind; reason?: string | undefined }>;

/** Loads the first page of published versions when the tab opens, so the workspace does not pay for it earlier. */
export function StudioHistoryTab({
  organizationId,
  rootId,
  savedRevision,
  restoreBlocked,
  hold,
  onRestored,
}: Readonly<{
  organizationId: string;
  rootId: string;
  /** Changes when the draft is saved, so the list is read again against the new saved state. */
  savedRevision: number;
  /** Why a version cannot be restored into the draft now, or nothing. */
  restoreBlocked: string | undefined;
  /** Holds the workspace's draft while a restore runs. */
  hold: (on: boolean) => void;
  /** Loads the restored saved draft into the workspace, saying what happened. */
  onRestored: (message: string) => void;
}>) {
  const [load, setLoad] = useState<HistoryLoad>({ kind: "loading" });
  useEffect(() => {
    let current = true;
    setLoad({ kind: "loading" });
    listApplicationReleaseHistory(organizationId, { kind: "reload", rootId }).then(
      (result) => {
        if (!current) return;
        setLoad(
          result.kind === "available"
            ? { kind: "available", page: result.page }
            : { kind: "unavailable", failure: result.kind, reason: result.reason },
        );
      },
      (error: unknown) => {
        console.error("[studio] release history failed to load", error);
        if (current) setLoad({ kind: "unavailable", failure: "temporarily_unavailable" });
      },
    );
    return () => {
      current = false;
    };
  }, [organizationId, rootId, savedRevision]);
  if (load.kind === "loading") return <p role="status">Loading the published versions…</p>;
  if (load.kind === "unavailable")
    return <p role="status">{unavailableMessage(load.failure, load.reason)}</p>;
  const snapshot = load.page.snapshot;
  return (
    <ApplicationReleaseHistory
      key={`${snapshot.organizationId}:${snapshot.rootId}:${snapshot.draftRevision}:${snapshot.sourceFingerprint}:${snapshot.anchorReleaseRevision}`}
      initialPage={load.page}
      restoreBlocked={restoreBlocked}
      hold={hold}
      onRestored={onRestored}
    />
  );
}
