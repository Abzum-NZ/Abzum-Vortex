import { Alert, AlertDescription, AlertTitle } from "@vortex/ui/components/alert";
import { unavailableMessage, type StudioUnavailableKind } from "./studio-refusal-messages";

const titles: Readonly<Record<StudioUnavailableKind, string>> = {
  refused: "refused",
  conflict: "changed while loading",
  temporarily_unavailable: "temporarily unavailable",
  validation_failed: "not valid",
  dependency_unavailable: "missing a release",
  no_change: "unchanged",
};

/** The one place a Studio page shows a loader that did not return the draft, with the loader's own reason. */
export function StudioUnavailable({
  subject,
  result,
  reloadHref,
}: {
  subject: string;
  result: Readonly<{ kind: StudioUnavailableKind; reason?: string | undefined }>;
  reloadHref?: string;
}) {
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <Alert variant={result.kind === "temporarily_unavailable" ? "default" : "destructive"}>
        <AlertTitle>
          {subject} {titles[result.kind]}
        </AlertTitle>
        <AlertDescription>
          <p role="status">{unavailableMessage(result.kind, result.reason)}</p>
          {result.reason === undefined ? null : <p className="text-xs">Reason: {result.reason}</p>}
        </AlertDescription>
      </Alert>
      {reloadHref === undefined ? null : (
        <a className="underline" href={reloadHref}>
          Reload
        </a>
      )}
    </main>
  );
}
