import Link from "next/link";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";

/**
 * The platform's notice above an Application running as a preview of a saved draft. It is not
 * part of the Application's frame: it says which draft this is, that what is saved here stays in
 * the preview, and leads back to Studio.
 */
export function DraftPreviewNotice({
  draftRevision,
  expiresAt,
  studioHref,
}: Readonly<{ draftRevision: number; expiresAt: string; studioHref: string }>) {
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
        <strong>Preview of draft revision {draftRevision}.</strong> It runs on a copy of your
        organisation&apos;s records; nothing saved here reaches the installed application. It
        ends {until}.
      </p>
      <Button variant="outline" size="sm" nativeButton={false} render={<Link href={studioHref} />}>
        <Icon name="chevron-left" />
        Back to Studio
      </Button>
    </div>
  );
}
