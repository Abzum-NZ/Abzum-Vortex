import { useCallback, type Dispatch, type SetStateAction, type RefObject } from "react";
import type { useRouter } from "next/navigation";
import type {
  createPlatformComponentRegistryForReleases,
  FlowDispatchResult,
  FormFlowFeedback,
} from "@vortex/ui";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import { applicationPageAddressPath } from "../../../../../../_lib/address-paths";
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
  placementRequestsRef: RefObject<{
    base: string;
    key: string;
    generations: Map<string, ComponentRequestGeneration>;
  }>;
  navigationKey: string;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setNotice: Dispatch<SetStateAction<Notice | undefined>>;
  setFormFeedback: Dispatch<SetStateAction<Readonly<Record<string, FormFlowFeedback>>>>;
  router: ReturnType<typeof useRouter>;
  model: ApplicationPageModel;
  platformComponentRegistry: ReturnType<typeof createPlatformComponentRegistryForReleases>;
  setCompletedGuidedNavigationKey: Dispatch<SetStateAction<string | undefined>>;
  refreshPlacements: (
    placementIds: readonly string[],
    tableContinuation?: TableContinuationTarget,
    options?: Readonly<{ content?: true }>,
  ) => Promise<void>;
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
      const isCurrentNavigation = (): boolean => placementRequestsRef.current.key === navigationKey;
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
        // A refusal must remain visible after a flow's form dialog has closed.
        setNotice(
          formPlacementId === undefined || resultNotice.tone === "problem"
            ? resultNotice
            : undefined,
        );
        if (formPlacementId !== undefined) {
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
          // Use the same authored reason for the form feedback and the page notice.
          const correctionMessages = (diagnostic?.corrections ?? []).flatMap((correction) =>
            correction.message === undefined ? [] : [correction.message],
          );
          const ruleMessages =
            diagnostic?.ruleRefusal !== undefined
              ? [diagnostic.ruleRefusal.message]
              : correctionMessages.length > 0
                ? [...new Set(correctionMessages)]
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
                  ...(ruleMessages === undefined ? {} : { ruleMessages }),
                  ...(recovery === undefined ? {} : { recovery }),
                };
          if (diagnostic !== undefined) {
            const reason: Notice =
              ruleMessages === undefined
                ? refusalNotices[diagnostic.code]
                : { tone: "problem", text: ruleMessages.join(" ") };
            const presentation = diagnostic.presentation;
            resultNotice = {
              ...reason,
              ...(presentation === undefined
                ? {}
                : {
                    link: {
                      label: presentation.link_label,
                      href: applicationPageAddressPath(
                        model.invocation.tenantShortName,
                        model.invocation.organizationShortName,
                        presentation.destination.application_key,
                        presentation.destination.page_key,
                      ),
                    },
                  }),
              text:
                recovery === undefined
                  ? (presentation?.message ?? reason.text)
                  : `${presentation?.message ?? reason.text} ${resultNotice.text}`,
            };
          }
          if (
            afterAccepted !== undefined &&
            ["completed", "committed", "background_pending"].includes(server.descriptor.outcome)
          ) {
            try {
              resultNotice = (await afterAccepted()) ?? resultNotice;
            } catch {
              resultNotice = unavailableNotice;
            }
          }
          if (!isCurrentNavigation()) return;
          const sourceEvent = Object.values(model.bindings).flat()
            .find((binding) => binding.bindingId === sourceBindingId)?.event;
          const initialized = (sourceEvent === "form_ready" || sourceEvent === "load") &&
            server.descriptor.outcome === "completed" && server.failure === undefined &&
            server.descriptor.commit !== "confirmed" && server.descriptor.commit !== "partial";
          if (!initialized) showResult(resultNotice, refusalFeedback);
          // A finished guided-form submission may have abandoned its draft. Keep the journey
          // visible but inactive until a new page load establishes the next draft.
          if (
            model.guidedForm !== undefined &&
            (afterAccepted !== undefined ||
              server.descriptor.commit === "confirmed" ||
              server.descriptor.commit === "partial")
          )
            setCompletedGuidedNavigationKey(navigationKey);
          // A committed run already re-read the bound placements before its closing messages (the
          // flow runtime's committed hook). A refusal because the record changed under the person
          // leaves their view stale, so the bound placements are re-read to show it as it now is.
          const changedUnderPerson =
            server.descriptor.outcome === "conflict" || diagnostic?.code === "stale_revision";
          if (
            changedUnderPerson &&
            server.descriptor.commit !== "confirmed" &&
            server.descriptor.commit !== "partial" &&
            sourceBindingId !== undefined
          )
            void refreshPlacements(refreshTargetsForBinding(sourceBindingId), undefined, {
              content: true,
            });
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
            void refreshPlacements(refreshTargetsForBinding(sourceBindingId), undefined, {
              content: true,
            });
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
