import type { ReactElement, ReactNode } from "react";
import type { BlockPropertyValueV2Contract, PlatformBlockReleaseV2 } from "@vortex/contracts";
import { Alert, AlertDescription } from "../components/alert";
import { Badge } from "../components/badge";
import { Empty, EmptyHeader, EmptyDescription } from "../components/empty";
import { Skeleton } from "../components/skeleton";
import { cn } from "../lib/utils";
import type { DisplayDataState, DisplayRefusalReason } from "./projected-data";

/** Safe, data-free presentation text for fixed refusal reasons. */
const REFUSAL_MESSAGES: Readonly<Record<DisplayRefusalReason, string>> = Object.freeze({
  not_permitted: "You do not have permission to view this content",
  access_ended: "Access to this content has ended",
  not_found: "Content not found",
});

/**
 * Reads the authored accessible name only through the block's declared
 * `accessibleNamePropertyPath`; it never guesses a setting from its key.
 * Returns undefined when the block declares no name or the optional name is absent.
 */
export function getAccessibleName(
  settings: Readonly<Record<string, BlockPropertyValueV2Contract>>,
  metadata: PlatformBlockReleaseV2,
): string | undefined {
  const capabilities = metadata.capabilities;
  if (capabilities.accessibleName === "not_applicable") return undefined;
  let current: Readonly<Record<string, BlockPropertyValueV2Contract>> = settings;
  const path = capabilities.accessibleNamePropertyPath;
  for (const [index, key] of path.entries()) {
    const value = Object.hasOwn(current, key) ? current[key] : undefined;
    if (value === undefined) return undefined;
    if (index === path.length - 1)
      return value.kind === "text" && value.value.trim().length > 0 ? value.value.trim() : undefined;
    if (value.kind !== "group") return undefined;
    current = value.properties;
  }
  return undefined;
}

export type DisplayStateContainerProps<Values> = Readonly<{
  /** Accessible name for the affected component; the block palette name when none is authored. */
  accessibleName: string;
  availability: "available" | "unavailable";
  /** The state this block's own registration validated. */
  projectedData: DisplayDataState<Values>;
  emptyMessage: string;
  /** Authored refused text shown in place of the fixed reason text. */
  refusedMessage?: string;
  /** Authored error text shown in place of the fixed neutral error text. */
  errorMessage?: string;
  children: ReactNode;
}>;

/**
 * Standard container for display component states, rendered with shadcn Skeleton, Empty, Alert
 * and Badge parts. Loading, empty, refused and error states render data-free text (fixed, or
 * authored for a block that declares it) announced at the component. A viewable placement
 * whose use is unavailable keeps its permitted content with a fixed unavailable note;
 * its components receive no semantic callbacks.
 */
export function DisplayStateContainer<Values>({
  accessibleName,
  availability,
  projectedData,
  emptyMessage,
  refusedMessage,
  errorMessage,
  children,
}: DisplayStateContainerProps<Values>): ReactElement {
  if (projectedData.status === "loading") {
    return (
      <div
        role="status"
        aria-busy="true"
        data-vortex-display-state="loading"
        className={cn("flex flex-col gap-2", "vortex-display-state vortex-display-loading")}
        aria-label={`Loading ${accessibleName}`}
      >
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
        <span className={cn("text-sm text-muted-foreground", "vortex-state-message")}>
          Loading…
        </span>
      </div>
    );
  }

  if (projectedData.status === "empty") {
    return (
      <Empty
        role="status"
        data-vortex-display-state="empty"
        className={cn("vortex-display-state vortex-display-empty")}
        aria-label={`${accessibleName}: empty`}
      >
        <EmptyHeader>
          <EmptyDescription className={cn("vortex-state-message")}>
            {emptyMessage}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (projectedData.status === "refused") {
    return (
      <Empty
        role="status"
        data-vortex-display-state="refused"
        data-vortex-refusal-reason={projectedData.reason}
        className={cn("vortex-display-state vortex-display-refused")}
        aria-label={`${accessibleName}: unavailable`}
      >
        <EmptyHeader>
          <EmptyDescription className={cn("vortex-state-message")}>
            {refusedMessage ?? REFUSAL_MESSAGES[projectedData.reason]}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (projectedData.status === "error") {
    return (
      <Alert
        variant="destructive"
        data-vortex-display-state="error"
        className={cn("vortex-display-state vortex-display-error")}
        aria-label={`${accessibleName}: could not be loaded`}
      >
        <AlertDescription className={cn("vortex-state-message")}>
          {errorMessage ?? "Content could not be loaded"}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <>
      {availability === "unavailable" ? (
        <div
          role="status"
          data-vortex-display-state="unavailable"
          className={cn("vortex-display-state vortex-display-unavailable")}
        >
          <Badge variant="secondary" className={cn("vortex-state-message")}>
            Actions are unavailable
          </Badge>
        </div>
      ) : null}
      {children}
    </>
  );
}
