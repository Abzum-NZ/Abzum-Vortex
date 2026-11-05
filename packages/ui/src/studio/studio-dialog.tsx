"use client";
import { useRef, type FormEvent, type ReactNode } from "react";
import { Button } from "../components/button";
import { FieldGroup } from "../components/field";
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
  finalFocus,
  focusDialog = false,
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
  /** Where focus goes when the dialog closes, when it was not opened from a control that stays. */
  finalFocus?: (() => HTMLElement | false) | undefined;
  /**
   * Focus starts on the dialog itself, which its title names, instead of its first control: for a
   * dialog whose first control is a menu button, so the first Escape closes it.
   */
  focusDialog?: boolean;
  children: ReactNode;
}>) {
  const popup = useRef<HTMLDivElement>(null);
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
      <DialogContent
        ref={popup}
        className="sm:max-w-md"
        finalFocus={finalFocus}
        {...(focusDialog ? { initialFocus: popup } : {})}
      >
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
          <form onSubmit={submit}>
            <FieldGroup>
              {children}
              {footer}
            </FieldGroup>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
