import type { MouseEvent, KeyboardEvent, ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import {
  getAccessibleName,
  type ControlEventHandlers,
  type ProjectedControlData,
} from "./projected-data";

export type ButtonProps = PlatformBlockRenderProps & {
  controlData?: ProjectedControlData;
  controlEvents?: ControlEventHandlers;
};

/**
 * Action and form button component supporting primary, secondary, danger and ghost variants,
 * submit and reset modes, keyboard activation (Enter, Space), accessible labeling,
 * and declared action / form_submit / form_reset semantic event emission.
 */
export function Button({
  placementId,
  settings,
  metadata,
  availability,
  controlData,
  controlEvents,
}: ButtonProps): ReactElement {
  const labelText = getAccessibleName(settings, metadata) ?? "Button";
  const actionKey = settings.action_key?.kind === "text" ? settings.action_key.value : undefined;
  const actionKind =
    settings.action_kind?.kind === "choice" ? settings.action_kind.value : "action";
  const variant = settings.variant?.kind === "choice" ? settings.variant.value : "primary";
  const isSettingDisabled = settings.disabled?.kind === "boolean" ? settings.disabled.value : false;

  const isControlDisabled =
    controlData?.status === "disabled" ||
    (controlData?.status === "ready" &&
      controlData.values.kind === "button" &&
      Boolean(controlData.values.disabled));

  const isLoading =
    controlData?.status === "loading" ||
    (controlData?.status === "ready" &&
      controlData.values.kind === "button" &&
      Boolean(controlData.values.loading));

  const isDisabled =
    availability === "unavailable" || isSettingDisabled || isControlDisabled || isLoading;

  const handleClick = (e: MouseEvent<HTMLButtonElement>): void => {
    if (isDisabled) {
      e.preventDefault();
      return;
    }

    if (availability !== "available") return;

    if (actionKind === "submit") {
      if (controlEvents?.form_submit) {
        controlEvents.form_submit({ event: "form_submit" });
      } else if (controlEvents?.action) {
        controlEvents.action({ event: "action", ...(actionKey ? { actionKey } : { actionKey: "submit" }) });
      }
    } else if (actionKind === "reset") {
      if (controlEvents?.form_reset) {
        controlEvents.form_reset({ event: "form_reset" });
      } else if (controlEvents?.action) {
        controlEvents.action({ event: "action", ...(actionKey ? { actionKey } : { actionKey: "reset" }) });
      }
    } else {
      if (controlEvents?.action) {
        controlEvents.action({ event: "action", ...(actionKey ? { actionKey } : {}) });
      }
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === "Enter" || e.key === " ") {
      // Natural button behavior handles click; when custom handling is needed, handleClick fires.
    }
  };

  const variantStyles = (() => {
    switch (variant) {
      case "secondary":
        return {
          backgroundColor: "#f3f4f6",
          color: "#1f2937",
          border: "1px solid #d1d5db",
        };
      case "danger":
        return {
          backgroundColor: "#dc2626",
          color: "#ffffff",
          border: "1px solid transparent",
        };
      case "ghost":
        return {
          backgroundColor: "transparent",
          color: "#374151",
          border: "1px solid transparent",
        };
      case "primary":
      default:
        return {
          backgroundColor: "#2563eb",
          color: "#ffffff",
          border: "1px solid transparent",
        };
    }
  })();

  const buttonType = actionKind === "submit" ? "submit" : actionKind === "reset" ? "reset" : "button";

  return (
    <button
      id={`vortex-btn-${placementId}`}
      type={buttonType}
      data-vortex-control="button"
      data-vortex-action-kind={actionKind}
      data-vortex-variant={variant}
      data-vortex-availability={availability}
      {...(actionKey ? { "data-vortex-action-key": actionKey } : {})}
      disabled={isDisabled}
      aria-label={labelText}
      aria-disabled={isDisabled ? "true" : "false"}
      aria-busy={isLoading ? "true" : "false"}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={`vortex-button vortex-button-${variant}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.5rem",
        padding: "0.5rem 1rem",
        fontSize: "0.875rem",
        fontWeight: 500,
        borderRadius: "0.375rem",
        cursor: isDisabled ? "not-allowed" : "pointer",
        opacity: isDisabled ? 0.6 : 1,
        transition: "all 0.15s ease-in-out",
        ...variantStyles,
      }}
    >
      {isLoading && (
        <span aria-hidden="true" style={{ animation: "spin 1s linear infinite" }}>
          ⏳
        </span>
      )}
      <span>{labelText}</span>
    </button>
  );
}
