"use client";

import type { ReactElement } from "react";
import { XIcon } from "lucide-react";
import { Button } from "../components/button";
import {
  Dialog as DialogRoot,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/dialog";
import {
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../components/sheet";
import { cn } from "../lib/utils";
import {
  readControlSettings,
  resolveControlContext,
  type ControlRenderProps,
} from "./control-context";
import { useSeededState } from "./field-parts";

export type ModalSurfaceKind = "dialog" | "drawer";
export type DrawerPlacement = "left" | "right" | "top" | "bottom";

/** The one payload member both modal surfaces read: the projected open state. */
type ModalSurfacePayload = Readonly<{ open: boolean }>;

type SurfaceSize = "small" | "medium" | "large";

/** Dialog widths from the theme's scale, centered on the page. */
const DIALOG_SIZES: Readonly<Record<SurfaceSize, string>> = {
  small: "sm:max-w-sm",
  medium: "sm:max-w-xl",
  large: "sm:max-w-4xl",
};

/** Drawer extents from the theme's scale, measured along the declared placement edge. */
const DRAWER_EDGE_SIZES = {
  vertical: {
    small: "w-full sm:max-w-xs",
    medium: "w-full sm:max-w-md",
    large: "w-full sm:max-w-xl",
  },
  horizontal: {
    small: "max-h-80",
    medium: "max-h-md",
    large: "max-h-2xl",
  },
} as const;

const drawerSizeClass = (placement: DrawerPlacement, size: SurfaceSize): string =>
  placement === "left" || placement === "right"
    ? DRAWER_EDGE_SIZES.vertical[size]
    : DRAWER_EDGE_SIZES.horizontal[size];

/**
 * Shared modal surface for dialogs and drawers, built on the shadcn Dialog and Sheet components
 * (Base UI): the primitive traps focus inside the surface, makes the rest of the page inert and
 * returns focus to the element that had focus when the surface opened. Escape and the close
 * control dismiss it, emitting only the declared `action` event with intent `dismiss`; pressing
 * outside the surface never dismisses. A projected `open` value drives the declared `open` and
 * `close` state operations, and the rendered surface advertises exactly those declared operations
 * for the placement's flow tasks.
 */
export function ModalSurface<Values extends ModalSurfacePayload>({
  props,
  kind,
  drawerPlacement,
  dataAttributes,
}: Readonly<{
  props: ControlRenderProps<Values>;
  kind: ModalSurfaceKind;
  drawerPlacement?: DrawerPlacement;
  dataAttributes?: Readonly<Record<`data-${string}`, string>>;
}>): ReactElement {
  const context = resolveControlContext<Values>(props, ["action"]);
  const settings = readControlSettings(props, context.location);
  const size = settings.choice<SurfaceSize>("size", "medium");
  const title = context.accessibleName ?? props.metadata.name;
  const [open, setOpen] = useSeededState(context.values?.open ?? settings.boolean("open"));

  const dismiss = (): void => {
    setOpen(false);
    context.events?.action?.({ event: "action", intent: "dismiss" });
  };

  const onOpenChange = (
    nextOpen: boolean,
    eventDetails: { reason?: string },
  ): void => {
    if (nextOpen) return;
    // Only the declared dismissal paths close the surface: Escape and the close control exit,
    // while pressing the backdrop does not.
    if (eventDetails.reason === "escape-key" || eventDetails.reason === "close-press") dismiss();
  };

  const sharedDataAttributes = {
    "data-vortex-control": kind,
    "data-vortex-placement-id": props.placementId,
    "data-vortex-open": String(open),
    "data-vortex-state-operations": props.metadata.supportedStateOperations.join(" "),
    "data-vortex-size": size,
    ...(dataAttributes ?? {}),
  };

  const closeButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={cn("absolute", kind === "dialog" ? "top-2 right-2" : "top-3 right-3")}
      aria-label={`Close ${title}`}
      onClick={dismiss}
    >
      <XIcon />
    </Button>
  );

  if (kind === "drawer") {
    return (
      <DialogRoot open={open} onOpenChange={onOpenChange}>
        <SheetContent side={drawerPlacement ?? "right"} showCloseButton={false}
          className={cn(drawerSizeClass(drawerPlacement ?? "right", size))}
          {...sharedDataAttributes}
        >
          <SheetHeader>
            <SheetTitle>{title}</SheetTitle>
          </SheetHeader>
          {closeButton}
          <div className="flex-1 overflow-y-auto px-4">{props.slots.content ?? null}</div>
          {props.slots.actions === undefined || props.slots.actions === null ? null : (
            <SheetFooter>{props.slots.actions}</SheetFooter>
          )}
        </SheetContent>
      </DialogRoot>
    );
  }

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className={cn(DIALOG_SIZES[size])}
        {...sharedDataAttributes}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {closeButton}
        <div>{props.slots.content ?? null}</div>
        {props.slots.actions === undefined || props.slots.actions === null ? null : (
          <DialogFooter>{props.slots.actions}</DialogFooter>
        )}
      </DialogContent>
    </DialogRoot>
  );
}
