import { isRecord } from "@vortex/platform/schema";
import { useCallback, useMemo, type Dispatch, type SetStateAction, type RefObject } from "react";
import type { createFormBlockRuntime } from "@vortex/ui";
import type {
  ApplicationPageModel,
  PlacementFlowBinding,
} from "../../../../../../_lib/application-page";
import type { PageMessageDraft } from "./types";
import type { useApplyDispatch } from "./use-apply-dispatch";
import { asComponentBinding } from "./event-values";
import { placementIdsInLayout } from "./placement-helpers";
import { unavailableNotice } from "./notices";

export function useGuidedFormSteps({
  model,
  formOwners,
  busy,
  guidedFormCompleted,
  setBusy,
  showPageMessage,
  applyDispatch,
  formBlock,
  setQuery,
  requestedStepId,
}: Readonly<{
  model: ApplicationPageModel;
  formOwners: Readonly<Record<string, string>>;
  busy: boolean;
  guidedFormCompleted: boolean;
  setBusy: Dispatch<SetStateAction<boolean>>;
  showPageMessage: (message: PageMessageDraft | undefined) => void;
  applyDispatch: ReturnType<typeof useApplyDispatch>["applyDispatch"];
  formBlock: ReturnType<typeof createFormBlockRuntime>;
  setQuery: (change: (parameters: URLSearchParams) => void) => void;
  requestedStepId: RefObject<string | undefined>;
}>) {
  const guidedActivePlacementIds = useMemo(() => {
    const guidedForm = model.guidedForm;
    const composition = model.page.composition;
    if (!guidedForm || !isRecord(composition) || !isRecord(composition.stepContent))
      return undefined;
    return placementIdsInLayout(composition.stepContent[guidedForm.activeStepId]);
  }, [model.guidedForm, model.page]);
  const guidedActiveFormIds = useMemo(
    () =>
      guidedActivePlacementIds === undefined
        ? []
        : [...guidedActivePlacementIds].filter(
            (placementId) => formOwners[placementId] === placementId,
          ),
    [formOwners, guidedActivePlacementIds],
  );
  const guidedSummaryStepId = useMemo(() => {
    if (!Array.isArray(model.page.steps)) return undefined;
    const summary = model.page.steps.find(
      (step) => isRecord(step) && step.summary === true && typeof step.id === "string",
    );
    return isRecord(summary) && typeof summary.id === "string" ? summary.id : undefined;
  }, [model.page]);
  const guidedPreviousStepId = useMemo(() => {
    const activeStepId = model.guidedForm?.activeStepId;
    if (activeStepId === undefined || !Array.isArray(model.page.steps)) return undefined;
    const activeIndex = model.page.steps.findIndex(
      (step) => isRecord(step) && step.id === activeStepId,
    );
    if (activeIndex <= 0) return undefined;
    const previous = model.page.steps[activeIndex - 1];
    return isRecord(previous) && typeof previous.id === "string" ? previous.id : undefined;
  }, [model.guidedForm?.activeStepId, model.page]);

  /** One flow dispatch of the guided form's own bound event, carrying the draft it names. */
  const runGuidedBinding = useCallback(
    async (
      placementId: string,
      binding: PlacementFlowBinding,
      inputs: Readonly<Record<string, unknown>>,
    ) => {
      if (busy || guidedFormCompleted) return;
      setBusy(true);
      showPageMessage(undefined);
      try {
        await applyDispatch(
          formBlock.guided(asComponentBinding(placementId, binding), inputs, crypto.randomUUID()),
          placementId,
          undefined,
          binding.bindingId,
        );
      } finally {
        setBusy(false);
      }
    },
    [applyDispatch, busy, formBlock, guidedFormCompleted, setBusy, showPageMessage],
  );

  const advanceGuidedStep = useCallback(
    async (
      placementId: string,
      stepId: string,
      values: Readonly<Record<string, unknown>>,
      requested?: string,
    ) => {
      const guidedForm = model.guidedForm;
      if (guidedForm === undefined) return;
      const binding = (model.bindings[placementId] ?? []).find(
        (held) => held.event === "guided_step_changed",
      );
      if (binding === undefined) {
        showPageMessage(unavailableNotice);
        return;
      }
      await runGuidedBinding(placementId, binding, {
        draft_id: guidedForm.draftId,
        revision: guidedForm.revision,
        step: stepId,
        ...(requested === undefined ? {} : { requested_step: requested }),
        values,
      });
    },
    [model.bindings, model.guidedForm, runGuidedBinding, showPageMessage],
  );

  const guidedCancel = useMemo(() => {
    for (const placementId of guidedActiveFormIds) {
      const binding = (model.bindings[placementId] ?? []).find(
        (held) => held.event === "form_cancel",
      );
      if (binding !== undefined) return { placementId, binding };
    }
    return undefined;
  }, [guidedActiveFormIds, model.bindings]);

  const cancelGuidedForm = useCallback(async () => {
    const guidedForm = model.guidedForm;
    if (guidedForm === undefined || guidedCancel === undefined) return;
    await runGuidedBinding(guidedCancel.placementId, guidedCancel.binding, {
      draft_id: guidedForm.draftId,
      revision: guidedForm.revision,
    });
  }, [guidedCancel, model.guidedForm, runGuidedBinding]);

  const requestGuidedStep = useCallback(
    (requested?: string) => {
      const guidedForm = model.guidedForm;
      if (guidedForm === undefined || busy || guidedFormCompleted) return;
      // Going back from the summary changes nothing in the draft: only the page address changes.
      if (requested !== undefined && guidedForm.activeStepId === guidedSummaryStepId) {
        setQuery((parameters) => parameters.set("step", requested));
        return;
      }
      requestedStepId.current = requested;
      const boundSummaryFormId =
        guidedForm.activeStepId === guidedSummaryStepId
          ? guidedActiveFormIds.find((placementId) =>
              (model.bindings[placementId] ?? []).some(
                (binding) =>
                  binding.event === "form_submit" &&
                  binding.flowId.toLowerCase() === guidedForm.flowId.toLowerCase(),
              ),
            )
          : undefined;
      const activeFormId = boundSummaryFormId ?? guidedActiveFormIds[0];
      const activeForm =
        activeFormId === undefined
          ? undefined
          : [
              ...document.querySelectorAll<HTMLFormElement>(
                'form[data-vortex-control="form-container"]',
              ),
            ].find((form) => form.dataset.vortexPlacementId === activeFormId);
      if (activeForm !== undefined) {
        activeForm.requestSubmit();
        return;
      }
      requestedStepId.current = undefined;
      const stepFormId = guidedActiveFormIds[0];
      if (stepFormId === undefined) showPageMessage(unavailableNotice);
      else void advanceGuidedStep(stepFormId, guidedForm.activeStepId, {}, requested);
    },
    [
      advanceGuidedStep,
      busy,
      guidedFormCompleted,
      guidedActiveFormIds,
      guidedSummaryStepId,
      model.bindings,
      model.guidedForm,
    ],
  );

  return {
    guidedActiveFormIds,
    guidedActivePlacementIds,
    guidedSummaryStepId,
    guidedCanCancel: guidedCancel !== undefined,
    cancelGuidedForm,
    advanceGuidedStep,
    guidedPreviousStepId,
    requestGuidedStep,
  };
}
