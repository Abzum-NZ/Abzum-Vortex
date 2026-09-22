import type { ReactElement, ReactNode } from "react";
import type { BlockPropertyValueV2Contract, PlatformBlockReleaseV2 } from "@vortex/contracts";
import type { DisplayRefusalReason, ProjectedDisplayData } from "./projected-data";

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

export type DisplayStateContainerProps = Readonly<{
  /** Accessible name for the affected component; the block palette name when none is authored. */
  accessibleName: string;
  availability: "available" | "unavailable";
  projectedData: ProjectedDisplayData;
  emptyMessage: string;
  children: ReactNode;
}>;

/**
 * Standard container for display component states. Loading, empty and refused states
 * render fixed data-free text announced politely at the component. A viewable placement
 * whose use is unavailable keeps its permitted content with a fixed unavailable note;
 * its components receive no semantic callbacks.
 */
export function DisplayStateContainer({
  accessibleName,
  availability,
  projectedData,
  emptyMessage,
  children,
}: DisplayStateContainerProps): ReactElement {
  if (projectedData.status === "loading") {
    return (
      <div
        role="status"
        aria-busy="true"
        data-vortex-display-state="loading"
        className="vortex-display-state vortex-display-loading"
        aria-label={`Loading ${accessibleName}`}
      >
        <span className="vortex-state-message">Loading…</span>
      </div>
    );
  }

  if (projectedData.status === "empty") {
    return (
      <div
        role="status"
        data-vortex-display-state="empty"
        className="vortex-display-state vortex-display-empty"
        aria-label={`${accessibleName}: empty`}
      >
        <span className="vortex-state-message">{emptyMessage}</span>
      </div>
    );
  }

  if (projectedData.status === "refused") {
    return (
      <div
        role="status"
        data-vortex-display-state="refused"
        data-vortex-refusal-reason={projectedData.reason}
        className="vortex-display-state vortex-display-refused"
        aria-label={`${accessibleName}: unavailable`}
      >
        <span className="vortex-state-message">{REFUSAL_MESSAGES[projectedData.reason]}</span>
      </div>
    );
  }

  return (
    <>
      {availability === "unavailable" ? (
        <div
          role="status"
          data-vortex-display-state="unavailable"
          className="vortex-display-state vortex-display-unavailable"
        >
          <span className="vortex-state-message">Actions are unavailable</span>
        </div>
      ) : null}
      {children}
    </>
  );
}
