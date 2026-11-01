import { Alert, AlertDescription, AlertTitle } from "@vortex/ui/components/alert";
import { NavigationLink } from "@vortex/ui/routing";
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
          <p role="status">
            {result.reason === "source_invalid_platform"
              ? "This draft could not be read because of a platform problem. It has been logged; your published app keeps working."
              : result.reason === "publication_invalid_platform"
                ? "This app could not be prepared because of a platform problem. It has been logged."
                : unavailableMessage(result.kind, result.reason)}
          </p>
          {result.reason === undefined ? null : <p className="text-xs">Reason: {result.reason}</p>}
        </AlertDescription>
      </Alert>
      {reloadHref === undefined ? null : (
        <NavigationLink className="underline" href={reloadHref}>
          Reload
        </NavigationLink>
      )}
    </main>
  );
}
