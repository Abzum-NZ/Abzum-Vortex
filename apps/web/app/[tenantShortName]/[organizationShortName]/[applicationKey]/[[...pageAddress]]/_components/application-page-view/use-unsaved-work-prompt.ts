import { useCallback, useEffect, useRef } from "react";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { useUnsavedWorkGuard, useUnsavedWorkRegistry } from "@vortex/ui";

/**
 * Guards the page against losing unsaved work: the one shared confirmation prompt the frame's
 * navigator asks before an in-place page change, and the browser's own prompt before the document
 * is left; the returned `confirmDialog` is rendered once by the page.
 */
export function useUnsavedWorkPrompt() {
  const [confirm, confirmDialog] = useConfirm();
  const unsavedWorkRegistry = useUnsavedWorkRegistry();

  // One leave question at a time: a second navigation while it is open stays on the page, so a
  // queued prompt never asks again after the first answer has already discarded the work.
  const asking = useRef(false);
  const confirmDiscardUnsavedWork = useCallback(async (): Promise<boolean> => {
    if (asking.current) return false;
    asking.current = true;
    try {
      const leave = await confirm({
        title: "Leave this page?",
        description: "Your unsaved changes will be lost.",
        confirmLabel: "Leave",
        cancelLabel: "Stay",
      });
      if (leave) unsavedWorkRegistry?.clearAll();
      return leave;
    } finally {
      asking.current = false;
    }
  }, [confirm, unsavedWorkRegistry]);
  const { hasUnsavedWork, guard: unsavedWork } = useUnsavedWorkGuard(confirmDiscardUnsavedWork);

  useEffect(() => {
    if (!hasUnsavedWork) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!unsavedWork.hasUnsavedWork()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsavedWork, unsavedWork]);

  return { unsavedWorkRegistry, unsavedWork, confirmDialog };
}
