import type { ReactElement, ReactNode } from "react";
import type { BlockPropertyValueV2Contract, PlatformBlockReleaseV2 } from "@vortex/contracts";
import { Alert, AlertDescription } from "../components/alert";
import { Badge } from "../components/badge";
import { Card } from "../components/card";
import { Empty, EmptyHeader, EmptyDescription } from "../components/empty";
import { Skeleton } from "../components/skeleton";
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
 * Standard container for display component states, rendered with the shadcn Card, Skeleton,
 * Empty, Alert and Badge parts. Loading, empty, refused and error states render data-free text
 * (fixed, or authored for a block that declares it) announced at the component. A viewable
 * placement whose use is unavailable keeps its permitted content with a fixed unavailable note;
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
      <Card
        role="status"
        aria-busy="true"
        data-vortex-display-state="loading"
        aria-label={`Loading ${accessibleName}`}
      >
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
        </div>
        <span className="text-sm text-muted-foreground">Loading…</span>
      </Card>
    );
  }

  if (projectedData.status === "empty") {
    return (
      <Empty
        role="status"
        data-vortex-display-state="empty"
        className="border"
        aria-label={`${accessibleName}: empty`}
      >
        <EmptyHeader>
          <EmptyDescription>{emptyMessage}</EmptyDescription>
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
        className="border border-l-4 border-l-destructive"
        aria-label={`${accessibleName}: unavailable`}
      >
        <EmptyHeader>
          <EmptyDescription>
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
        aria-label={`${accessibleName}: could not be loaded`}
      >
        <AlertDescription>{errorMessage ?? "Content could not be loaded"}</AlertDescription>
      </Alert>
    );
  }

  return (
    <>
      {availability === "unavailable" ? (
        <div role="status" data-vortex-display-state="unavailable" className="mb-2">
          <Badge variant="secondary">Actions are unavailable</Badge>
        </div>
      ) : null}
      {children}
    </>
  );
}
