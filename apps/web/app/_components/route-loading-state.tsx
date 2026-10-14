import { Skeleton } from "@vortex/ui/components/skeleton";

/**
 * The one loading state for a route segment, shown the moment a link is clicked while the server
 * decides access and reads the page. It carries no data. A whole-page segment shows a shell-neutral
 * content placeholder; an application page shows it in the content region of the application
 * frame, which stays in place around it.
 */
export function RouteLoadingState({ region = "page" }: Readonly<{ region?: "page" | "content" }>) {
  return (
    <div
      className={region === "page" ? "flex min-h-svh flex-col gap-4 p-6" : "flex flex-col gap-4"}
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading</span>
      <Skeleton className="h-8 w-64 max-w-full rounded-md bg-muted" />
      <Skeleton className="h-32 w-full rounded-lg bg-muted" />
      <Skeleton className="h-64 w-full rounded-lg bg-muted" />
    </div>
  );
}
