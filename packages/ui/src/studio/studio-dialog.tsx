"use client";
import type { FormEvent, ReactNode } from "react";
import { Button } from "../components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/dialog";

/**
 * The one dialog for Studio's inspector editors. The title stays in sentence case (the application
 * style capitalises dialog titles), and the footer puts Cancel left of the primary button. With
 * `submitLabel` the body and footer form one form, so Enter submits.
 */
export function StudioDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  closeLabel = "Close",
  submitDisabled = false,
  onSubmit,
  children,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** The primary button's text; omitted for a dialog that only closes. */
  submitLabel?: string;
  /** The button of a dialog that only closes. */
  closeLabel?: string;
  submitDisabled?: boolean;
  onSubmit?: () => void;
  children: ReactNode;
}>) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The dialog is portalled, but its events still reach the inspector form that opened it.
    event.stopPropagation();
    onSubmit?.();
  };
  const footer = (
    <DialogFooter>
      <DialogClose render={<Button type="button" variant="outline" />}>
        {submitLabel === undefined ? closeLabel : "Cancel"}
      </DialogClose>
      {submitLabel !== undefined && (
        <Button type="submit" disabled={submitDisabled}>
          {submitLabel}
        </Button>
      )}
    </DialogFooter>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description !== undefined && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {submitLabel === undefined ? (
          <>
            {children}
            {footer}
          </>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {children}
            {footer}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
