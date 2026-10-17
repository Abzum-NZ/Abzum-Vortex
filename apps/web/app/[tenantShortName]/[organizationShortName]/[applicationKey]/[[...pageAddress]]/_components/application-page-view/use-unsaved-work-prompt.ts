import { useCallback, useEffect } from "react";
import type { useRouter } from "next/navigation";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { useUnsavedWorkGuard, useUnsavedWorkRegistry } from "@vortex/ui";

/**
 * Guards the page against losing unsaved work: the one shared confirmation prompt asks before a
 * link, a flow's Navigate task or the browser leaves a page that holds input, and the returned
 * `confirmDialog` is rendered once by the page.
 */
export function useUnsavedWorkPrompt({
  router,
}: Readonly<{
  router: ReturnType<typeof useRouter>;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  const unsavedWorkRegistry = useUnsavedWorkRegistry();

  const confirmDiscardUnsavedWork = useCallback(async (): Promise<boolean> => {
    const leave = await confirm({
      title: "Leave this page?",
      description: "Your unsaved changes will be lost.",
      confirmLabel: "Leave",
      cancelLabel: "Stay",
    });
    if (leave) unsavedWorkRegistry?.clearAll();
    return leave;
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

  useEffect(() => {
    if (!hasUnsavedWork) return;
    const onDocumentClick = (event: MouseEvent): void => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const target =
        event.target instanceof Element
          ? event.target
          : event.target instanceof Node
            ? event.target.parentElement
            : null;
      const anchor = target?.closest<HTMLAnchorElement>("a[href]");
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        (anchor.target !== "" && anchor.target.toLowerCase() !== "_self") ||
        anchor.hasAttribute("download")
      )
        return;
      let address: URL;
      try {
        address = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (!["http:", "https:"].includes(address.protocol) || !unsavedWork.hasUnsavedWork()) return;
      if (
        address.origin === window.location.origin &&
        address.pathname === window.location.pathname &&
        address.search === window.location.search
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        if (!(await unsavedWork.confirmDiscardUnsavedWork())) return;
        if (address.origin === window.location.origin)
          router.push(`${address.pathname}${address.search}${address.hash}`);
        else window.location.assign(address.href);
      })();
    };
    document.addEventListener("click", onDocumentClick, true);
    return () => document.removeEventListener("click", onDocumentClick, true);
  }, [hasUnsavedWork, router, unsavedWork]);

  return { unsavedWorkRegistry, unsavedWork, confirmDialog };
}
