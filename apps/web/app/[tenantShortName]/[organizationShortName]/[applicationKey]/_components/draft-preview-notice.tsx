import Link from "next/link";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { DraftPreviewBoundNotice } from "./draft-preview-bound-notice";

/**
 * The platform's notice above an Application running as a preview of a saved draft. It is not
 * part of the Application's frame: it says which draft this is, that what is saved here stays in
 * the preview, and leads back to Studio. On a page whose records reached the preview bound it also
 * says that only the first records the builder can see are in the preview.
 */
export function DraftPreviewNotice({
  draftRevision,
  expiresAt,
  studioHref,
  seedBound,
  seedBoundedPages,
}: Readonly<{
  draftRevision: number;
  expiresAt: string;
  studioHref: string;
  seedBound: number;
  seedBoundedPages: Readonly<Record<string, string>>;
}>) {
  const until = new Date(expiresAt).toLocaleString("en-NZ", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <div
      role="status"
      data-vortex-draft-preview={draftRevision}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-50"
    >
      <Icon name="eye" />
      <p className="min-w-0 flex-1">
        <strong>Preview of draft revision {draftRevision}.</strong> It runs on a copy of the
        records you can see in the installed application; nothing saved here reaches it. It
        ends{" "}{until}.
      </p>
      <DraftPreviewBoundNotice seedBound={seedBound} seedBoundedPages={seedBoundedPages} />
      <Button variant="outline" size="sm" nativeButton={false} render={<Link href={studioHref} />}>
        <Icon name="chevron-left" />
        Back to Studio
      </Button>
    </div>
  );
}
