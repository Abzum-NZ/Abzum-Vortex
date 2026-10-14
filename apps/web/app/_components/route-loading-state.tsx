import { Skeleton } from "@vortex/ui/components/skeleton";

/**
 * The loading state of a whole-page route segment outside an application (sign-in, Studio),
 * shown the moment a link is clicked while the server decides access and reads the page. It
 * carries no data. Application pages have no route skeleton: a click keeps the current page until
 * the next one is ready, and only a placement whose own data is slow shows its own skeleton.
 */
export function RouteLoadingState() {
  return (
    <div className="flex min-h-svh flex-col gap-4 p-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      <Skeleton className="h-8 w-64 max-w-full rounded-md bg-muted" />
      <Skeleton className="h-32 w-full rounded-lg bg-muted" />
      <Skeleton className="h-64 w-full rounded-lg bg-muted" />
    </div>
  );
}
