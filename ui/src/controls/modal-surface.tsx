"use client";

import {
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type ReactElement,
  type SyntheticEvent,
} from "react";
import {
  readControlSettings,
  resolveControlContext,
  type ControlRenderProps,
} from "./control-context";
import { useSeededState } from "./field-parts";

export type ModalSurfaceKind = "dialog" | "drawer";

const focusIfConnected = (element: HTMLElement | null): void => {
  if (element !== null && element.isConnected) element.focus();
};

/**
 * Shared modal surface for dialogs and drawers, built on the native modal `<dialog>`: the
 * browser makes the rest of the page inert, moves focus into the surface and keeps Tab inside
 * it. Escape and the close button dismiss it, emitting only the declared `action` event with
 * intent `dismiss`, and focus returns to the element that was focused when it opened. A projected
 * `open` value drives the declared `open` and `close` state operations, and the rendered surface
 * advertises exactly those declared operations for the placement's flow tasks.
 */
/** The one payload member both modal surfaces read: the projected open state. */
type ModalSurfacePayload = Readonly<{ open: boolean }>;

export function ModalSurface<Values extends ModalSurfacePayload>({
  props,
  kind,
  surfaceStyle,
  dataAttributes,
}: Readonly<{
  props: ControlRenderProps<Values>;
  kind: ModalSurfaceKind;
  surfaceStyle: (size: "small" | "medium" | "large") => CSSProperties;
  dataAttributes?: Readonly<Record<`data-${string}`, string>>;
}>): ReactElement {
  const context = resolveControlContext<Values>(props, ["action"]);
  const settings = readControlSettings(props, context.location);
  const size = settings.choice<"small" | "medium" | "large">("size", "medium");
  const title = context.accessibleName ?? props.metadata.name;
  const titleId = useId();
  const [open, setOpen] = useSeededState(context.values?.open ?? settings.boolean("open"));
  const surfaceRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) return;
    if (open && !surface.open) {
      const focused = document.activeElement;
      returnFocusRef.current = focused instanceof HTMLElement ? focused : null;
      surface.showModal();
    } else if (!open && surface.open) {
      surface.close();
    }
  }, [open]);

  // Unmounting while open (for example a page transition) still returns focus.
  useEffect(() => () => focusIfConnected(returnFocusRef.current), []);

  const dismiss = (): void => {
    setOpen(false);
    context.events?.action?.({ event: "action", intent: "dismiss" });
  };

  const onCancel = (event: SyntheticEvent<HTMLDialogElement>): void => {
    event.preventDefault();
    dismiss();
  };

  const onClose = (): void => {
    focusIfConnected(returnFocusRef.current);
    returnFocusRef.current = null;
    // The browser may close a modal itself (for example a repeated Escape); keep state truthful.
    if (open) dismiss();
  };

  return (
    <dialog
      ref={surfaceRef}
      aria-labelledby={titleId}
      data-vortex-control={kind}
      data-vortex-placement-id={props.placementId}
      data-vortex-open={String(open)}
      data-vortex-state-operations={props.metadata.supportedStateOperations.join(" ")}
      data-vortex-size={size}
      {...(dataAttributes ?? {})}
      onCancel={onCancel}
      onClose={onClose}
      className={`vortex-${kind}`}
      style={surfaceStyle(size)}
    >
      <div className={`vortex-${kind}-header`}>
        <h2 id={titleId} className={`vortex-${kind}-title`}>
          {title}
        </h2>
        <button
          type="button"
          aria-label={`Close ${title}`}
          onClick={dismiss}
          className={`vortex-${kind}-close`}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div className={`vortex-${kind}-body`}>{props.slots.content ?? null}</div>
      {props.slots.actions === undefined || props.slots.actions === null ? null : (
        <div className={`vortex-${kind}-actions`}>{props.slots.actions}</div>
      )}
    </dialog>
  );
}
