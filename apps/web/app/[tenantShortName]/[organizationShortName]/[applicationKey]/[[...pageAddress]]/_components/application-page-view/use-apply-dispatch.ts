import { useCallback, type Dispatch, type SetStateAction, type RefObject } from "react";
import { toast } from "@vortex/ui/components/sonner";
import type { useRouter } from "next/navigation";
import type {
  createPlatformComponentRegistryForReleases,
  ServerDrivenResult,
  FormFlowFeedback,
} from "@vortex/ui";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import { applicationPageAddressPath } from "../../../../../../_lib/address-paths";
import type { ComponentRequestGeneration } from "@vortex/platform/schema";
import type { ControlReport, DispatchOutcome, Notice, TableContinuationTarget } from "./types";
import {
  unavailableNotice,
  finishedNotice,
  multiFactorPath,
  reauthenticationPath,
  refusalNotices,
  outcomeNotices,
} from "./notices";
import { formSurfaceComposition, visibleOwningFormFieldLabel } from "./form-surface";

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
      dispatch: Promise<ServerDrivenResult | undefined>,
      formPlacementId?: string,
      afterAccepted?: () => Promise<Notice | undefined>,
      sourceBindingId?: string,
      /** The control reports its outcome; what must not vanish with it also stays on the page. */
      reportOnControl?: ControlReport,
    ): Promise<DispatchOutcome> => {
      let outcome: DispatchOutcome = { notice: undefined, confirmed: false, changed: false };
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
        outcome = { ...outcome, notice: resultNotice };
        // A control shows text only: a way forward, and a problem a transient control would lose,
        // stay visible and actionable on the page.
        if (
          reportOnControl !== undefined &&
          resultNotice.link === undefined &&
          (reportOnControl === "in_place" || resultNotice.tone !== "problem")
        )
          return;
        // A form on the page shows its own outcome where the person is looking; the page repeats
        // it only when it offers a way forward (a link). A refusal from a flow's form dialog must
        // remain visible after the dialog has closed, so it stays on the page.
        const formOnPage =
          formPlacementId !== undefined &&
          formSurfaceComposition(
            model.page,
            model.pageId,
            formPlacementId,
            platformComponentRegistry,
          ) !== undefined;
        if (formOnPage && resultNotice.link === undefined) setNotice(undefined);
        else
          setNotice((current) => {
            // A client intent can refuse after the server has completed (for example, a page the
            // viewer cannot open). A successful run must not erase that more specific refusal.
            if (current?.tone === "problem" && resultNotice.tone !== "problem") return current;
            return formPlacementId === undefined || resultNotice.tone === "problem"
              ? resultNotice
              : undefined;
          });
        // A confirmed change is announced once, in the notifications region, which stays while
        // the page moves on (a saved form usually opens what it saved).
        if (resultNotice.tone !== "problem" && formOnPage) return;
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
        const server = await dispatch;
        if (!isCurrentNavigation()) return outcome;
        if (server === undefined) {
          settles = false;
          return outcome;
        }
        if (server.kind === "reload") {
          router.refresh();
          return outcome;
        }
        if (server.kind === "finished") {
          let resultNotice = finishedNotice(
            server.descriptor.outcome,
            server.failure?.code,
            server.descriptor.commit,
          );
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
          const authoredMessages = [
            ...new Set([
              ...(diagnostic?.ruleRefusal === undefined ? [] : [diagnostic.ruleRefusal.message]),
              ...correctionMessages,
            ]),
          ];
          const ruleMessages = authoredMessages.length > 0 ? authoredMessages : undefined;
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
                  ? (diagnostic.presentation?.message ?? reason.text)
                  : `${diagnostic.presentation?.message ?? reason.text} ${resultNotice.text}`,
            };
          }
          // Signing in again, or verifying, comes back to this page and record, where the person can retry.
          if (
            resultNotice.link?.href === reauthenticationPath ||
            resultNotice.link?.href === multiFactorPath
          )
            resultNotice = {
              ...resultNotice,
              link: {
                ...resultNotice.link,
                href: `${resultNotice.link.href}&${new URLSearchParams({
                  continuation: JSON.stringify({
                    kind: "application_page",
                    tenantShortName: model.invocation.tenantShortName,
                    organizationShortName: model.invocation.organizationShortName,
                    applicationKey: model.invocation.applicationKey,
                    pageKey: model.invocation.pageKey,
                    ...(model.subject === undefined ? {} : { recordId: model.subject.recordId }),
                  }),
                })}`,
              },
            };
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
          if (!isCurrentNavigation()) return outcome;
          // Reads, navigation and initialization have no write to confirm. Authored messages
          // are already presented by the flow host; keep failures and gesture-specific feedback.
          const silentCompletion =
            resultNotice === outcomeNotices.completed &&
            server.failure === undefined &&
            server.descriptor.commit !== "confirmed" &&
            server.descriptor.commit !== "partial";
          if (!silentCompletion) showResult(resultNotice, refusalFeedback);
          const changedUnderPerson =
            server.descriptor.outcome === "conflict" || diagnostic?.code === "stale_revision";
          const confirmed =
            server.descriptor.commit === "confirmed" &&
            ["completed", "committed"].includes(server.descriptor.outcome) &&
            server.failure === undefined;
          // A saved form usually opens what it saved: its confirmation is a toast that outlives
          // this page (other gestures confirm through the page notice's own toast).
          if (
            confirmed &&
            formPlacementId !== undefined &&
            resultNotice.tone !== "problem" &&
            resultNotice.link === undefined
          )
            toast.success(resultNotice.text);
          outcome = {
            ...outcome,
            confirmed,
            changed: changedUnderPerson,
            ...(diagnostic?.corrections === undefined
              ? {}
              : { corrections: diagnostic.corrections }),
          };
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
          if (
            changedUnderPerson &&
            server.descriptor.commit !== "confirmed" &&
            server.descriptor.commit !== "partial" &&
            sourceBindingId !== undefined
          )
            void refreshPlacements(refreshTargetsForBinding(sourceBindingId), undefined, {
              content: true,
            });
          return outcome;
        }
        if (server.kind === "refused") {
          showResult(unavailableNotice);
          return outcome;
        }
        if (server.kind === "abandoned") {
          // A surface that went away at a pause before any answer was sent: nothing to report.
          if (server.unanswered) return outcome;
          // The run may have committed a step before the answer was lost: never report nothing.
          showResult(outcomeNotices.uncertain ?? unavailableNotice);
          if (model.guidedForm !== undefined) setCompletedGuidedNavigationKey(navigationKey);
          if (sourceBindingId !== undefined)
            void refreshPlacements(refreshTargetsForBinding(sourceBindingId), undefined, {
              content: true,
            });
          return outcome;
        }
        showResult(unavailableNotice);
        return outcome;
      } catch {
        if (isCurrentNavigation()) showResult(unavailableNotice);
        return outcome;
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
