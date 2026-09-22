import type { ReactElement, ReactNode } from "react";
import type { BlockPropertyValueV2Contract } from "@vortex/contracts";
import type { DisplayRefusalReason, ProjectedDisplayData } from "./projected-data";

/** Safe, data-free presentation text for fixed refusal reasons. */
const REFUSAL_MESSAGES: Readonly<Record<DisplayRefusalReason, string>> = Object.freeze({
  not_permitted: "You do not have permission to view this content",
  access_ended: "Access to this content has ended",
  not_found: "Content not found",
});

/**
 * Extracts a safe accessible name from block settings, falling back to a default label.
 */
export function getAccessibleName(
  settings: Readonly<Record<string, BlockPropertyValueV2Contract>> | undefined,
  fallback: string,
): string {
  if (settings) {
    const title = settings.title;
    if (
      title &&
      title.kind === "text" &&
      typeof title.value === "string" &&
      title.value.trim().length > 0
    ) {
      return title.value.trim();
    }
    const accessibleName = settings.accessible_name;
    if (
      accessibleName &&
      accessibleName.kind === "text" &&
      typeof accessibleName.value === "string" &&
      accessibleName.value.trim().length > 0
    ) {
      return accessibleName.value.trim();
    }
  }
  return fallback;
}

export type DisplayStateContainerProps = Readonly<{
  accessibleName: string;
  availability?: "available" | "unavailable";
  unavailableReason?: "operation_unavailable";
  projectedData?: ProjectedDisplayData;
  emptyMessage?: string;
  children: ReactNode;
}>;

/**
 * Standard container wrapping display component state transitions.
 * Ensures loading, empty, refused and unavailable states are accessible and data-safe;
 * refused data is never leaked to the DOM.
 */
export function DisplayStateContainer({
  accessibleName,
  availability = "available",
  unavailableReason,
  projectedData,
  emptyMessage = "No records available",
  children,
}: DisplayStateContainerProps): ReactElement {
  if (availability === "unavailable" || unavailableReason === "operation_unavailable") {
    return (
      <div
        role="alert"
        data-vortex-display-state="unavailable"
        className="vortex-display-state vortex-display-unavailable"
        aria-label={`Unavailable: ${accessibleName}`}
      >
        <span className="vortex-state-message">Operation unavailable</span>
      </div>
    );
  }

  if (projectedData?.status === "loading") {
    return (
      <div
        role="status"
        aria-busy="true"
        data-vortex-display-state="loading"
        className="vortex-display-state vortex-display-loading"
        aria-label={`Loading ${accessibleName}`}
      >
        <span className="vortex-state-message">Loading...</span>
      </div>
    );
  }

  if (projectedData?.status === "empty") {
    return (
      <div
        data-vortex-display-state="empty"
        className="vortex-display-state vortex-display-empty"
        aria-label={`Empty: ${accessibleName}`}
      >
        <span className="vortex-state-message">{emptyMessage}</span>
      </div>
    );
  }

  if (projectedData?.status === "refused") {
    const message = REFUSAL_MESSAGES[projectedData.reason] ?? "Content unavailable";
    return (
      <div
        role="alert"
        data-vortex-display-state="refused"
        data-vortex-refusal-reason={projectedData.reason}
        className="vortex-display-state vortex-display-refused"
        aria-label={`Access refused: ${accessibleName}`}
      >
        <span className="vortex-state-message">{message}</span>
      </div>
    );
  }

  return <>{children}</>;
}
