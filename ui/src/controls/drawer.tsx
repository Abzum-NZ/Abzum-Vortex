import { useState, useRef, useEffect, type CSSProperties, type KeyboardEvent, type ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import {
  getAccessibleName,
  type ControlEventHandlers,
  type ProjectedControlData,
} from "./projected-data";

export type DrawerProps = PlatformBlockRenderProps & {
  controlData?: ProjectedControlData;
  controlEvents?: ControlEventHandlers;
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible sliding drawer panel component following the WAI-ARIA dialog pattern:
 * - role="dialog", aria-modal="true", aria-labelledby
 * - Placements: left, right, top, bottom
 * - Focus entry into drawer upon opening
 * - Focus return to triggering element upon closing
 * - Focus trap keeping keyboard navigation inside the open drawer
 * - Escape key dismissal emitting action event with actionKey="close"
 * - Slots: "content" and optional "actions"
 */
export function Drawer({
  placementId,
  settings,
  metadata,
  slots,
  availability,
  controlData,
  controlEvents,
}: DrawerProps): ReactElement {
  const title = getAccessibleName(settings, metadata) ?? "Drawer";
  const initiallyOpen = settings.open?.kind === "boolean" ? settings.open.value : false;
  const placement =
    settings.placement?.kind === "choice" ? settings.placement.value : "right";
  const size = settings.size?.kind === "choice" ? settings.size.value : "medium";

  const projectedOpen =
    controlData?.status === "ready" && controlData.values.kind === "drawer"
      ? controlData.values.open
      : undefined;

  const [internalOpen, setInternalOpen] = useState<boolean>(projectedOpen ?? initiallyOpen);
  const isOpen = projectedOpen !== undefined ? projectedOpen : internalOpen;

  const drawerRef = useRef<HTMLDivElement>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  const titleId = `vortex-drawer-title-${placementId}`;

  useEffect(() => {
    if (isOpen) {
      previousActiveElementRef.current = document.activeElement as HTMLElement | null;
      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable && focusable.length > 0) {
        focusable[0]!.focus();
      } else {
        drawerRef.current?.focus();
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

    if (e.key === "Tab" && drawerRef.current) {
      const focusable = Array.from(
        drawerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
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
    return <div data-vortex-control="drawer" data-vortex-open="false" aria-hidden="true" />;
  }

  const dimension = size === "small" ? "300px" : size === "large" ? "600px" : "420px";

  const placementStyles: CSSProperties = (() => {
    switch (placement) {
      case "left":
        return {
          position: "fixed",
          top: 0,
          bottom: 0,
          left: 0,
          width: dimension,
          maxWidth: "100%",
        };
      case "top":
        return {
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          height: dimension,
          maxHeight: "100%",
        };
      case "bottom":
        return {
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          height: dimension,
          maxHeight: "100%",
        };
      case "right":
      default:
        return {
          position: "fixed",
          top: 0,
          bottom: 0,
          right: 0,
          width: dimension,
          maxWidth: "100%",
        };
    }
  })();

  return (
    <div
      role="presentation"
      className="vortex-drawer-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.4)",
        zIndex: 50,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        data-vortex-control="drawer"
        data-vortex-open="true"
        data-vortex-placement={placement}
        data-vortex-size={size}
        data-vortex-availability={availability}
        className="vortex-drawer-panel"
        style={{
          backgroundColor: "#ffffff",
          boxShadow: "-4px 0 15px rgba(0, 0, 0, 0.1)",
          display: "flex",
          flexDirection: "column",
          outline: "none",
          zIndex: 51,
          ...placementStyles,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "1rem 1.25rem",
            borderBottom: "1px solid #e5e7eb",
          }}
        >
          <h2
            id={titleId}
            style={{ margin: 0, fontSize: "1.125rem", fontWeight: 600, color: "#111827" }}
          >
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close drawer"
            onClick={handleClose}
            className="vortex-drawer-close-btn"
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

        <div style={{ padding: "1.25rem", overflowY: "auto", flex: 1 }}>{slots.content}</div>

        {slots.actions && (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: "0.75rem",
              padding: "1rem 1.25rem",
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
