import { Alert, AlertDescription, AlertTitle } from "@vortex/ui/components/alert";
import { NavigationLink } from "@vortex/ui/routing";
import { unavailableMessage, type StudioUnavailableKind } from "./studio-refusal-messages";

const titles: Readonly<Record<StudioUnavailableKind, string>> = {
  refused: "is not available to your account",
  conflict: "changed while it was loading",
  temporarily_unavailable: "is temporarily unavailable",
  validation_failed: "cannot be opened",
  dependency_unavailable: "is missing a release",
  no_change: "has no changes",
};

/**
 * The one place a Studio page shows a loader that did not return the draft, with the sentence for
 * its reason (the reason code itself is never shown).
 */
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
          <h1>
            {subject} {titles[result.kind]}
          </h1>
        </AlertTitle>
        <AlertDescription>{unavailableMessage(result.kind, result.reason)}</AlertDescription>
      </Alert>
      {reloadHref === undefined ? null : (
        <NavigationLink className="underline" href={reloadHref}>
          Reload
        </NavigationLink>
      )}
    </main>
  );
}
