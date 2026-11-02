"use client";
import { useEffect, useState } from "react";
import { Alert, AlertAction, AlertDescription } from "@vortex/ui/components/alert";
import { Button } from "@vortex/ui/components/button";
import { Skeleton } from "@vortex/ui/components/skeleton";
import type { StudioApplicationHistoryPage } from "../../_lib/studio-application-history";
import { listApplicationReleaseHistory } from "../releases-actions";
import { unavailableMessage, type StudioUnavailableKind } from "./studio-refusal-messages";
import { ApplicationReleaseHistory } from "./application-release-history";

type HistoryLoad =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "available"; page: StudioApplicationHistoryPage }>
  | Readonly<{ kind: "unavailable"; failure: StudioUnavailableKind; reason?: string | undefined }>;

/** Loads the newest page of published versions when the tab opens, so the workspace does not pay for it earlier. */
export function StudioHistoryTab({
  organizationId,
  rootId,
  savedRevision,
  appStoreHref,
  restoreBlocked,
  hold,
  onRestored,
  onPublish,
}: Readonly<{
  organizationId: string;
  rootId: string;
  /** Changes when the draft is saved, so the list is read again against the new saved state. */
  savedRevision: number;
  /** The App Store page that shows the application, when the standing names one. */
  appStoreHref: string | undefined;
  /** Why a version cannot be restored into the draft now, or nothing. */
  restoreBlocked: string | undefined;
  /** Holds the workspace's draft while a restore runs. */
  hold: (on: boolean) => void;
  /** Loads the restored saved draft into the workspace, saying what happened. */
  onRestored: (message: string) => void;
  /** Starts Publish, offered where nothing is published yet. */
  onPublish: () => void;
}>) {
  const [load, setLoad] = useState<HistoryLoad>({ kind: "loading" });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let current = true;
    setLoad({ kind: "loading" });
    listApplicationReleaseHistory(organizationId, { kind: "newest", rootId }).then(
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
  }, [organizationId, rootId, savedRevision, generation]);
  if (load.kind === "loading")
    return (
      <div className="space-y-2" role="status" aria-label="Loading the published versions">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  if (load.kind === "unavailable")
    return (
      <Alert variant="destructive">
        <AlertDescription>{unavailableMessage(load.failure, load.reason)}</AlertDescription>
        <AlertAction>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setGeneration((n) => n + 1)}
          >
            Reload
          </Button>
        </AlertAction>
      </Alert>
    );
  const snapshot = load.page.snapshot;
  return (
    <ApplicationReleaseHistory
      key={`${snapshot.organizationId}:${snapshot.rootId}:${snapshot.draftRevision}:${snapshot.sourceFingerprint}:${snapshot.anchorReleaseRevision}`}
      initialPage={load.page}
      appStoreHref={appStoreHref}
      restoreBlocked={restoreBlocked}
      hold={hold}
      onRestored={onRestored}
      onPublish={onPublish}
    />
  );
}
