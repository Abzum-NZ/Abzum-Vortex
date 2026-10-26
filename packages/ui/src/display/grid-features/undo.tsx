"use client";

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Button } from "../../components/button";
import { Icon } from "../../icons/icon";
import { gridOwnsEvent, useBatchEdit } from "./batch-edit-client";
import type { GridFeatureInteractionProps } from "./registry";
import type { DisplayBatchEditAnswer } from "../projected-data";

/**
 * Undo and redo of the batches this person committed in this session on this page (Ctrl+Z, Ctrl+Y
 * or Ctrl+Shift+Z, and two buttons for touch). The page keeps the stack; undoing sends the inverse
 * batch with the revisions the batches left behind, and the server refuses it when any record was
 * changed since, naming the records: nothing is ever overwritten silently. The stack is forgotten
 * when the person leaves the page or changes the query.
 */
export default function Undo({
  context,
  surface,
}: GridFeatureInteractionProps): ReactElement | null {
  const batch = useBatchEdit(context, surface);
  const [depth, setDepth] = useState<Readonly<{ undo: number; redo: number }>>({
    undo: 0,
    redo: 0,
  });
  const request = context.events?.batch_edit_requested;
  const latest = useRef({ batch, depth });
  latest.current = { batch, depth };

  // The depths are the page's to tell: read them on mount and whenever the shown page changes (a
  // new query or page address has forgotten its stack, a refresh after a batch has changed it).
  useEffect(() => {
    if (request === undefined) return;
    let current = true;
    void Promise.resolve(request({ event: "batch_edit_requested", action: "state" })).then(
      (answer) => {
        const held = answer as DisplayBatchEditAnswer | undefined;
        if (current && held !== undefined) setDepth({ undo: held.undoDepth, redo: held.redoDepth });
      },
      (error: unknown) => console.error("[grid] the undo stack could not be read", error),
    );
    return () => {
      current = false;
    };
  }, [request, context.rows]);

  const step = useCallback(async (action: "undo" | "redo"): Promise<void> => {
    // An empty stack has nothing to send.
    if ((action === "undo" ? latest.current.depth.undo : latest.current.depth.redo) === 0) return;
    const answer = await latest.current.batch.run(action);
    if (answer === undefined) return;
    setDepth({ undo: answer.undoDepth, redo: answer.redoDepth });
    if (answer.result?.kind === "saved")
      latest.current.batch.tell(action === "undo" ? "Undid the last change." : "Redid the change.");
  }, []);

  useEffect(() => {
    const root = surface.rootRef.current;
    if (root === null) return;
    const keydown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return;
      const key = event.key.toLowerCase();
      const action =
        key === "z"
          ? event.shiftKey
            ? "redo"
            : "undo"
          : key === "y" && !event.shiftKey
            ? "redo"
            : undefined;
      if (action === undefined || !gridOwnsEvent(event, root)) return;
      event.preventDefault();
      event.stopPropagation();
      void step(action);
    };
    root.addEventListener("keydown", keydown, true);
    return () => root.removeEventListener("keydown", keydown, true);
  }, [surface.rootRef, step]);

  if (depth.undo === 0 && depth.redo === 0) return null;

  return (
    <div className="flex items-center gap-2" aria-busy={batch.busy || undefined}>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={batch.busy || depth.undo === 0}
          aria-keyshortcuts="Control+Z"
          onClick={() => void step("undo")}
        >
          <Icon name="undo" data-icon="inline-start" aria-hidden="true" />
          Undo
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={batch.busy || depth.redo === 0}
          aria-keyshortcuts="Control+Y"
          onClick={() => void step("redo")}
        >
          <Icon name="redo" data-icon="inline-start" aria-hidden="true" />
          Redo
        </Button>
        <span className="sr-only">
          {`${depth.undo} ${depth.undo === 1 ? "change" : "changes"} to undo`}
        </span>
      </div>
      {batch.notice}
    </div>
  );
}
