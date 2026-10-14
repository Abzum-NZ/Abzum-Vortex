import { useCallback, type Dispatch, type SetStateAction, type RefObject } from "react";
import type { useRouter } from "next/navigation";
import type {
  createFullPlatformComponentRegistry,
  FlowDispatchResult,
  FormFlowFeedback,
} from "@vortex/ui";
import type { ApplicationPageModel } from "../../../../../_lib/application-page";
import type { ComponentRequestGeneration } from "@vortex/platform/schema";
import type { Notice, TableContinuationTarget } from "./types";
import { unavailableNotice, finishedNotice, refusalNotices, outcomeNotices } from "./notices";
import { visibleOwningFormFieldLabel } from "./form-surface";

export function useApplyDispatch({
  placementRequestsRef,
  navigationKey,
  setBusy,
  setNotice,
  setFormFeedback,
  router,
  model,
  platformComponentRegistry,
  setCompletedGuidedNavigationKey,
  refreshPlacements,
  refreshTargetsForBinding,
}: Readonly<{
  placementRequestsRef: RefObject<{ base: string; key: string; generations: Map<string, ComponentRequestGeneration> }>;
  navigationKey: string;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setNotice: Dispatch<SetStateAction<Notice | undefined>>;
  setFormFeedback: Dispatch<SetStateAction<Readonly<Record<string, FormFlowFeedback>>>>;
  router: ReturnType<typeof useRouter>;
  model: ApplicationPageModel;
  platformComponentRegistry: ReturnType<typeof createFullPlatformComponentRegistry>;
  setCompletedGuidedNavigationKey: Dispatch<SetStateAction<string | undefined>>;
  refreshPlacements: (placementIds: readonly string[], tableContinuation?: TableContinuationTarget) => Promise<void>;
  refreshTargetsForBinding: (bindingId: string) => readonly string[];
}>) {
  /**
   * Reports a server-driven flow's safe outcome for any gesture. The runtime already carried out
   * every pause through a continuation and every presentation intent through the host; only the
   * final outcome is shown, and affected placements re-read their persisted data after a write. A
   * gesture the form block ignored because the same binding is already running leaves the page as
   * that run set it.
   */
  const applyDispatch = useCallback(
    async (
      dispatch: Promise<FlowDispatchResult | undefined>,
      formPlacementId?: string,
      afterAccepted?: () => Promise<Notice | undefined>,
      sourceBindingId?: string,
    ) => {
      const isCurrentNavigation = (): boolean =>
        placementRequestsRef.current.key === navigationKey;
      setBusy(true);
      setNotice(undefined);
      if (formPlacementId !== undefined)
        setFormFeedback((current) => {
          if (!Object.hasOwn(current, formPlacementId)) return current;
          const next = { ...current };
          delete next[formPlacementId];
          return next;
        });
      const showResult = (
        resultNotice: Notice,
        refusalFeedback?: Extract<FormFlowFeedback, { kind: "refusal" }>,
      ): void => {
        if (formPlacementId === undefined) {
          setNotice(resultNotice);
        } else {
          setNotice(undefined);
          setFormFeedback((current) => ({
            ...current,
            [formPlacementId]: refusalFeedback ?? {
              kind: "message",
              tone: resultNotice.tone === "problem" ? "problem" : "success",
              text: resultNotice.text,
            },
          }));
        }
      };
      let settles = true;
      try {
        const result = await dispatch;
        if (!isCurrentNavigation()) return;
        if (result === undefined) {
          settles = false;
          return;
        }
        if (result.ranIn === "browser") {
          showResult(unavailableNotice);
          return;
        }
        const server = result.result;
        if (server.kind === "reload") {
          return router.refresh();
        }
        if (server.kind === "finished") {
          let resultNotice = finishedNotice(server.descriptor.outcome, server.failure?.code);
          const diagnostic = server.failure?.diagnostic;
          const fieldLabel =
            diagnostic?.submittedField === undefined || formPlacementId === undefined
              ? undefined
              : visibleOwningFormFieldLabel(
                  model.page,
                  model.pageId,
                  formPlacementId,
                  diagnostic.submittedField,
                  platformComponentRegistry,
                );
          const recovery =
            server.descriptor.outcome === "partial" || server.descriptor.outcome === "uncertain"
              ? server.descriptor.outcome
              : undefined;
          const refusalFeedback: Extract<FormFlowFeedback, { kind: "refusal" }> | undefined =
            diagnostic === undefined
              ? undefined
              : {
                  kind: "refusal" as const,
                  code: diagnostic.code,
                  ...(fieldLabel === undefined ? {} : { fieldLabel }),
                  ...(diagnostic.corrections === undefined
                    ? {}
                    : { corrections: diagnostic.corrections }),
                  ...(diagnostic.ruleRefusal === undefined
                    ? {}
                    : { ruleMessage: diagnostic.ruleRefusal.message }),
                  ...(recovery === undefined ? {} : { recovery }),
                };
          if (diagnostic !== undefined) {
            const reason: Notice =
              diagnostic.ruleRefusal === undefined
                ? refusalNotices[diagnostic.code]
                : { tone: "problem", text: diagnostic.ruleRefusal.message };
            resultNotice = {
              ...reason,
              text: recovery === undefined ? reason.text : `${reason.text} ${resultNotice.text}`,
            };
          }
          if (
            afterAccepted !== undefined &&
            ["completed", "committed", "background_pending"].includes(
              server.descriptor.outcome,
            )
          ) {
            try {
              resultNotice = (await afterAccepted()) ?? resultNotice;
            } catch {
              resultNotice = unavailableNotice;
            }
          }
          if (!isCurrentNavigation()) return;
          showResult(resultNotice, refusalFeedback);
          // A finished guided-form submission may have abandoned its draft. Keep the journey
          // visible but inactive until a new page load establishes the next draft.
          if (
            model.guidedForm !== undefined &&
            (afterAccepted !== undefined ||
              server.descriptor.commit === "confirmed" ||
              server.descriptor.commit === "partial")
          )
            setCompletedGuidedNavigationKey(navigationKey);
          if (
            (server.descriptor.commit === "confirmed" || server.descriptor.commit === "partial") &&
            sourceBindingId !== undefined
          )
            void refreshPlacements(refreshTargetsForBinding(sourceBindingId));
          return;
        }
        if (server.kind === "refused") {
          showResult(unavailableNotice);
          return;
        }
        if (server.kind === "abandoned") {
          // The run may have committed a step before the answer was lost: never report nothing.
          showResult(outcomeNotices.uncertain ?? unavailableNotice);
          if (model.guidedForm !== undefined) setCompletedGuidedNavigationKey(navigationKey);
          if (sourceBindingId !== undefined)
            void refreshPlacements(refreshTargetsForBinding(sourceBindingId));
          return;
        }
        showResult(unavailableNotice);
      } catch {
        if (isCurrentNavigation()) showResult(unavailableNotice);
      } finally {
        if (settles && isCurrentNavigation()) setBusy(false);
      }
    },
    [
      model.guidedForm,
      model.page,
      model.pageId,
      navigationKey,
      refreshPlacements,
      refreshTargetsForBinding,
      router,
    ],
  );

  return { applyDispatch };
}
