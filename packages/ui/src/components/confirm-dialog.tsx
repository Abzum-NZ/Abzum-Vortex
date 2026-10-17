"use client";

import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Button } from "./button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog";

/** The wording and the buttons of one confirmation prompt. */
type ConfirmPrompt = Readonly<{
  /** The question the prompt asks, shown as the dialog heading. */
  title: string;
  /** The message the prompt shows, kept from the wording it replaces. */
  description: string;
  /** Label of the button that answers yes. */
  confirmLabel: string;
  /** Label of the button that answers no. */
  cancelLabel?: string;
  /** Draws the answering button in the destructive variant. */
  destructive?: boolean;
  /** What the decision covers in detail, shown under the message. */
  details?: ReactNode;
}>;

type PendingPrompt = {
  readonly prompt: ConfirmPrompt;
  readonly answer: (confirmed: boolean) => void;
  settled: boolean;
};

/**
 * The one confirmation prompt, built on the shared AlertDialog in place of a native
 * `window.confirm`: it is themed with the application, traps focus, is answered with the
 * keyboard and cancels with Escape, and a press outside it changes nothing. `confirm`
 * resolves with the answered decision. A prompt asked while one is still open waits for
 * it, exactly as a blocking dialog would, so no caller's decision is lost.
 */
export function useConfirm(): readonly [(prompt: ConfirmPrompt) => Promise<boolean>, ReactElement] {
  const [open, setOpen] = useState<PendingPrompt | null>(null);
  const openPrompt = useRef<PendingPrompt | null>(null);
  const waiting = useRef<readonly PendingPrompt[]>([]);
  const answeredByPress = useRef(false);

  const show = useCallback((next: PendingPrompt | null): void => {
    openPrompt.current = next;
    setOpen(next);
  }, []);

  const answer = useCallback((confirmed: boolean) => {
    const current = openPrompt.current;
    if (current === null || current.settled) return;
    current.settled = true;
    show(waiting.current[0] ?? null);
    waiting.current = waiting.current.slice(1);
    current.answer(confirmed);
  }, [show]);

  const confirm = useCallback((prompt: ConfirmPrompt) => new Promise<boolean>((resolve) => {
    const pending: PendingPrompt = { prompt, answer: resolve, settled: false };
    if (openPrompt.current === null || openPrompt.current.settled) show(pending);
    else waiting.current = [...waiting.current, pending];
  }), [show]);

  // A button press answers the prompt itself; only Escape or an outside press asks for
  // the answer here, and both arrive as one close request after the press.
  const requestDismiss = useCallback(() => {
    if (answeredByPress.current) {
      answeredByPress.current = false;
      return;
    }
    answer(false);
  }, [answer]);

  const answerByPress = useCallback((confirmed: boolean) => {
    answeredByPress.current = true;
    answer(confirmed);
  }, [answer]);

  // An editor that unmounts with a prompt open must not leave its caller waiting for an answer.
  useEffect(() => () => {
    for (const pending of [openPrompt.current, ...waiting.current]) {
      if (pending !== null && !pending.settled) {
        pending.settled = true;
        pending.answer(false);
      }
    }
    openPrompt.current = null;
    waiting.current = [];
  }, []);

  const prompt = open?.prompt;
  const dialog: ReactElement = <AlertDialog
    open={open !== null}
    onOpenChange={(nextOpen) => { if (!nextOpen) requestDismiss(); }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{prompt?.title ?? ""}</AlertDialogTitle>
        <AlertDialogDescription>{prompt?.description ?? ""}</AlertDialogDescription>
      </AlertDialogHeader>
      {prompt?.details !== undefined && <div className="max-h-80 space-y-2 overflow-y-auto text-sm">{prompt.details}</div>}
      <AlertDialogFooter>
        <AlertDialogCancel onClick={() => answerByPress(false)}>{prompt?.cancelLabel ?? "Cancel"}</AlertDialogCancel>
        <AlertDialogAction
          render={<Button variant={prompt?.destructive === true ? "destructive" : "default"} />}
          onClick={() => answerByPress(true)}>{prompt?.confirmLabel ?? ""}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
  return [confirm, dialog];
}
