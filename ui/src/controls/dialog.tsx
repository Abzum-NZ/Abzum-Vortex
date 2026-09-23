import { useState, useRef, useEffect, type KeyboardEvent, type ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import {
  getAccessibleName,
  type ControlEventHandlers,
  type ProjectedControlData,
} from "./projected-data";

export type DialogProps = PlatformBlockRenderProps & {
  controlData?: ProjectedControlData;
  controlEvents?: ControlEventHandlers;
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal dialog component following the WAI-ARIA dialog pattern:
 * - role="dialog", aria-modal="true", aria-labelledby
 * - Focus entry into the dialog upon opening
 * - Focus return to the triggering element upon closing
 * - Focus trap keeping keyboard navigation inside the open dialog
 * - Escape key dismissal emitting action event with actionKey="close"
 * - Slots: "content" and optional "actions"
 */
export function Dialog({
  placementId,
  settings,
  metadata,
  slots,
  availability,
  controlData,
  controlEvents,
}: DialogProps): ReactElement {
  const title = getAccessibleName(settings, metadata) ?? "Dialog";
  const initiallyOpen = settings.open?.kind === "boolean" ? settings.open.value : false;
  const isModal = settings.modal?.kind === "boolean" ? settings.modal.value : true;
  const size = settings.size?.kind === "choice" ? settings.size.value : "medium";

  const projectedOpen =
    controlData?.status === "ready" && controlData.values.kind === "dialog"
      ? controlData.values.open
      : undefined;

  const [internalOpen, setInternalOpen] = useState<boolean>(projectedOpen ?? initiallyOpen);
  const isOpen = projectedOpen !== undefined ? projectedOpen : internalOpen;

  const dialogRef = useRef<HTMLDivElement>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  const titleId = `vortex-dialog-title-${placementId}`;

  // Handle focus entry and return
  useEffect(() => {
    if (isOpen) {
      previousActiveElementRef.current = document.activeElement as HTMLElement | null;
      // Focus first focusable element inside dialog or the dialog container itself
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable && focusable.length > 0) {
        focusable[0]!.focus();
      } else {
        dialogRef.current?.focus();
      }
    } else if (previousActiveElementRef.current) {
      previousActiveElementRef.current.focus();
      previousActiveElementRef.current = null;
    }
  }, [isOpen]);

  const handleClose = (): void => {
    setInternalOpen(false);
    if (availability === "available" && controlEvents?.action) {
      controlEvents.action({ event: "action", actionKey: "close" });
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!isOpen) return;

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      handleClose();
      return;
    }

    if (e.key === "Tab" && isModal && dialogRef.current) {
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }

      const firstElement = focusable[0]!;
      const lastElement = focusable[focusable.length - 1]!;

      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement.focus();
        }
      } else {
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement.focus();
        }
      }
    }
  };

  if (!isOpen) {
    return <div data-vortex-control="dialog" data-vortex-open="false" aria-hidden="true" />;
  }

  const maxWidth = size === "small" ? "400px" : size === "large" ? "800px" : "600px";

  return (
    <div
      role="presentation"
      className="vortex-dialog-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
        padding: "1rem",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && isModal) handleClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal={isModal ? "true" : "false"}
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        data-vortex-control="dialog"
        data-vortex-open="true"
        data-vortex-size={size}
        data-vortex-availability={availability}
        className="vortex-dialog-panel"
        style={{
          backgroundColor: "#ffffff",
          borderRadius: "0.5rem",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
          width: "100%",
          maxWidth,
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "1rem 1.5rem",
            borderBottom: "1px solid #e5e7eb",
          }}
        >
          <h2
            id={titleId}
            style={{ margin: 0, fontSize: "1.25rem", fontWeight: 600, color: "#111827" }}
          >
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close dialog"
            onClick={handleClose}
            className="vortex-dialog-close-btn"
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              fontSize: "1.25rem",
              lineHeight: 1,
              padding: "0.25rem 0.5rem",
              color: "#6b7280",
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: "1.5rem", overflowY: "auto", flex: 1 }}>{slots.content}</div>

        {slots.actions && (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: "0.75rem",
              padding: "1rem 1.5rem",
              borderTop: "1px solid #e5e7eb",
              backgroundColor: "#f9fafb",
            }}
          >
            {slots.actions}
          </div>
        )}
      </div>
    </div>
  );
}
