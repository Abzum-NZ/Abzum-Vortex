import { useCallback, type Dispatch, type SetStateAction, type RefObject } from "react";
import type { useRouter } from "next/navigation";
import type {
  createPlatformComponentRegistryForReleases,
  ServerDrivenResult,
  FormFlowFeedback,
  FlowRuntimeState,
} from "@vortex/ui";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import { applicationPageAddressPath } from "../../../../../../_lib/address-paths";
import type { ComponentRequestGeneration } from "@vortex/platform/schema";
import type {
  ControlReport,
  DispatchOutcome,
  PageMessageDraft,
  TableContinuationTarget,
} from "./types";
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
  showPageMessage,
  runtimeState,
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
  showPageMessage: (message: PageMessageDraft | undefined) => void;
  runtimeState: FlowRuntimeState;
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
      afterAccepted?: () => Promise<PageMessageDraft | undefined>,
      sourceBindingId?: string,
      /** The control reports its outcome; what must not vanish with it also stays on the page. */
      reportOnControl?: ControlReport,
    ): Promise<DispatchOutcome> => {
      let outcome: DispatchOutcome = { notice: undefined, confirmed: false, changed: false };
      const isCurrentNavigation = (): boolean => placementRequestsRef.current.key === navigationKey;
      showPageMessage(undefined);
      if (formPlacementId !== undefined) runtimeState.messages.clear("inline", formPlacementId);
      const showResult = (
        resultNotice: PageMessageDraft,
        refusalFeedback?: Extract<FormFlowFeedback, { kind: "refusal" }>,
      ): void => {
        outcome = { ...outcome, notice: resultNotice };
        // A control shows text only: a way forward, and a problem a transient control would lose,
        // stay visible and actionable on the page.
        if (
          reportOnControl !== undefined &&
          resultNotice.action === undefined &&
          (reportOnControl === "in_place" || resultNotice.severity !== "error")
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
        if (
          formOnPage &&
          resultNotice.action === undefined &&
          refusalFeedback?.corrections !== undefined
        ) {
          runtimeState.messages.show({
            id: crypto.randomUUID(),
            target: "inline",
            component: formPlacementId,
            severity: "error",
            text: resultNotice.text,
            refusal: refusalFeedback,
          });
        } else if (
          runtimeState.messages.read("banner")?.severity !== "error" ||
          resultNotice.severity === "error"
        )
          showPageMessage(resultNotice);
      };
      try {
        const server = await dispatch;
        if (!isCurrentNavigation()) return outcome;
        if (server === undefined) {
          return outcome;
        }
        if (server.kind === "reload") {
          router.refresh();
          return outcome;
        }
        if (server.kind === "cells_refused") {
          showResult({
            target: "banner",
            severity: "error",
            text: "Nothing was saved. Fix the cells listed and try again.",
          });
          return { ...outcome, cellProblems: server.problems };
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
          const corrections =
            diagnostic?.corrections ??
            (fieldLabel !== undefined &&
            diagnostic?.submittedField !== undefined &&
            diagnostic.ruleRefusal !== undefined
              ? [
                  {
                    field: diagnostic.submittedField,
                    code: "field_refused" as const,
                    message: diagnostic.ruleRefusal.message,
                  },
                ]
              : undefined);
          const refusalFeedback: Extract<FormFlowFeedback, { kind: "refusal" }> | undefined =
            diagnostic === undefined
              ? undefined
              : {
                  kind: "refusal" as const,
                  code: diagnostic.code,
                  ...(fieldLabel === undefined ? {} : { fieldLabel }),
                  ...(corrections === undefined ? {} : { corrections }),
                  ...(ruleMessages === undefined ? {} : { ruleMessages }),
                  ...(recovery === undefined ? {} : { recovery }),
                };
          if (diagnostic !== undefined) {
            const reason: PageMessageDraft =
              ruleMessages === undefined
                ? refusalNotices[diagnostic.code]
                : { target: "banner", severity: "error", text: ruleMessages.join(" ") };
            const presentation = diagnostic.presentation;
            resultNotice = {
              ...reason,
              ...(presentation === undefined
                ? {}
                : {
                    action: {
                      kind: "link" as const,
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
          const recoveryAction =
            resultNotice.action?.kind === "link" ? resultNotice.action : undefined;
          if (
            recoveryAction?.href === reauthenticationPath ||
            recoveryAction?.href === multiFactorPath
          )
            resultNotice = {
              ...resultNotice,
              action: {
                ...recoveryAction,
                href: `${recoveryAction.href}&${new URLSearchParams({
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
          // A run that finished well says so through its own flow steps (the "Saved" and "Deleted"
          // messages): the page reports only what went wrong, or needs the person to look at.
          const silentCompletion =
            (resultNotice === outcomeNotices.completed ||
              resultNotice === outcomeNotices.committed) &&
            server.failure === undefined;
          if (!silentCompletion) showResult(resultNotice, refusalFeedback);
          const changedUnderPerson =
            server.descriptor.outcome === "conflict" || diagnostic?.code === "stale_revision";
          const confirmed =
            server.descriptor.commit === "confirmed" &&
            ["completed", "committed"].includes(server.descriptor.outcome) &&
            server.failure === undefined;
          outcome = {
            ...outcome,
            confirmed,
            changed: changedUnderPerson,
            ...(server.outputs.applied === undefined ? {} : { applied: server.outputs.applied }),
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
          // A committed run's reply already carried the bound placements' rows. A refusal because
          // the record changed under the person leaves their view stale, so the bound placements
          // are re-read to show it as it now is.
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
        if (server.kind === "unknown") {
          if (server.controlId === undefined || server.retry === undefined) {
            console.error("[flow] unknown outcome has no originating control or retry");
            showResult(outcomeNotices.uncertain ?? unavailableNotice);
            return outcome;
          }
          const component = `retry:${server.controlId}`;
          const retry = server.retry;
          runtimeState.messages.show({
            id: crypto.randomUUID(),
            target: "inline",
            component,
            severity: "warning",
            text: "The outcome is unknown. Retry to check it.",
            action: {
              kind: "flow",
              label: "Retry",
              run: () => {
                runtimeState.messages.clear("inline", component);
                void applyDispatch(
                  retry(),
                  formPlacementId,
                  afterAccepted,
                  sourceBindingId,
                  reportOnControl,
                );
              },
            },
          });
          return outcome;
        }
        if (server.kind === "skipped") return outcome;
        if (server.kind === "refused") {
          showResult(
            server.reason === undefined
              ? unavailableNotice
              : { target: "banner", severity: "error", text: server.reason },
          );
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
      }
    },
    [
      model.guidedForm,
      model.page,
      model.pageId,
      navigationKey,
      refreshPlacements,
      refreshTargetsForBinding,
      runtimeState,
      router,
    ],
  );

  return { applyDispatch };
}
