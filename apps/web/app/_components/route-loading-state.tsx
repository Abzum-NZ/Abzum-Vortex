import { Skeleton } from "@vortex/ui/components/skeleton";

/**
 * The one loading state for a route segment, shown the moment a link is clicked while the server
 * decides access and reads the page. It is shell-neutral: the frame is declared by the page's
 * definition and is not known yet, so only a content placeholder appears and the real frame
 * replaces it. It carries no data.
 */
export function RouteLoadingState() {
  return (
    <div className="flex min-h-svh flex-col gap-4 p-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      <Skeleton className="h-8 w-64 rounded-md bg-muted" />
      <Skeleton className="h-32 w-full rounded-lg bg-muted" />
      <Skeleton className="h-64 w-full rounded-lg bg-muted" />
    </div>
  );
}
