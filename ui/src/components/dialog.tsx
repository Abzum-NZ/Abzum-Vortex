"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "../lib/utils";
import { useVortexStylePortalRoot } from "../theme/vortex-style-root";

import { Button } from "./button";
import { Icon } from "../icons/icon";

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

/** Flow surfaces render immediately after the page root, outside its React style context. */
function findStyleRoot(anchor: HTMLElement | null): HTMLElement | null {
  if (anchor === null) return null;

  let sibling = anchor.previousElementSibling;
  while (sibling !== null) {
    if (sibling instanceof HTMLElement && sibling.matches("[data-vortex-style-root]"))
      return sibling;
    sibling = sibling.previousElementSibling;
  }

  const focusedRoot = document.activeElement?.closest("[data-vortex-style-root]");
  if (focusedRoot instanceof HTMLElement) return focusedRoot;

  const roots = document.querySelectorAll("[data-vortex-style-root]");
  const onlyRoot = roots.length === 1 ? roots.item(0) : null;
  return onlyRoot instanceof HTMLElement ? onlyRoot : null;
}

function DialogPortal({ container, ...props }: DialogPrimitive.Portal.Props) {
  const styleRoot = useVortexStylePortalRoot();
  const [anchor, setAnchor] = React.useState<HTMLSpanElement | null>(null);
  if (styleRoot !== null && styleRoot.element === null && container === undefined) return null;
  const needsAnchor = styleRoot === null && container === undefined;
  const fallbackRoot = needsAnchor ? findStyleRoot(anchor) : null;
  return (
    <>
      {needsAnchor && <span ref={setAnchor} hidden aria-hidden="true" />}
      {(!needsAnchor || anchor !== null) && (
        <DialogPrimitive.Portal
          data-slot="dialog-portal"
          container={container ?? styleRoot?.element ?? fallbackRoot ?? undefined}
          {...props}
        />
      )}
    </>
  );
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn("cn-dialog-overlay fixed inset-0 isolate z-50", className)}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "cn-dialog-content fixed top-1/2 left-1/2 z-50 w-full -translate-x-1/2 -translate-y-1/2 outline-none",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={<Button variant="ghost" className="cn-dialog-close" size="icon-sm" />}
          >
            <Icon name="close" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="dialog-header" className={cn("cn-dialog-header flex flex-col", className)} {...props} />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "cn-dialog-footer flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>Close</DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("cn-dialog-title font-heading", className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("cn-dialog-description", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
