import { Skeleton } from "@vortex/ui/components/skeleton";

/**
 * The one loading state for a route segment, shown the moment a link is clicked while the server
 * decides access and reads the page. It carries no data: a top bar, a side column and a content
 * area as placeholders, so the new frame appears immediately and the content fills in.
 */
export function RouteLoadingState() {
  return (
    <div className="flex min-h-svh flex-col" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      <div className="flex h-14 items-center gap-4 border-b px-4">
        <Skeleton className="h-6 w-32 rounded-md bg-muted" />
        <Skeleton className="ml-auto size-8 rounded-full bg-muted" />
      </div>
      <div className="flex flex-1">
        <div className="hidden w-60 flex-col gap-3 border-r p-4 md:flex">
          <Skeleton className="h-5 w-full rounded-md bg-muted" />
          <Skeleton className="h-5 w-4/5 rounded-md bg-muted" />
          <Skeleton className="h-5 w-3/5 rounded-md bg-muted" />
        </div>
        <div className="flex flex-1 flex-col gap-4 p-6">
          <Skeleton className="h-8 w-64 rounded-md bg-muted" />
          <Skeleton className="h-32 w-full rounded-lg bg-muted" />
          <Skeleton className="h-64 w-full rounded-lg bg-muted" />
        </div>
      </div>
    </div>
  );
}
