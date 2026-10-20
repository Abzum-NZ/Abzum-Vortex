import { isRecord } from "@vortex/platform/schema";
import { useCallback, useMemo, type Dispatch, type SetStateAction, type RefObject } from "react";
import type { useRouter, useSearchParams } from "next/navigation";
import type {
  createFormBlockRuntime,
  useUnsavedWorkRegistry} from "@vortex/ui";
import type {
  FlowDispatchResult,
} from "@vortex/ui";
import type {
  ApplicationPageModel,
  PlacementFlowBinding,
} from "../../../../../../_lib/application-page";
import type { Notice, GuidedFormActions } from "./types";
import { asComponentBinding } from "./event-values";
import { placementIdsInLayout } from "./placement-helpers";
import { unavailableNotice } from "./notices";

export function useGuidedFormSteps({
  model,
  formOwners,
  application,
  subject,
  busy,
  guidedFormCompleted,
  setBusy,
  setNotice,
  guidedFormActions,
  searchParams,
  router,
  setQuery,
  requestedStepId,
  guidedSubmitInFlight,
  unsavedWorkRegistry,
  formBlock,
  applyDispatch,
}: Readonly<{
  model: ApplicationPageModel;
  formOwners: Readonly<Record<string, string>>;
  application: ApplicationPageModel["invocation"];
  subject: ApplicationPageModel["subject"];
  busy: boolean;
  guidedFormCompleted: boolean;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setNotice: Dispatch<SetStateAction<Notice | undefined>>;
  guidedFormActions: GuidedFormActions;
  searchParams: ReturnType<typeof useSearchParams>;
  router: ReturnType<typeof useRouter>;
  setQuery: (change: (parameters: URLSearchParams) => void) => void;
  requestedStepId: RefObject<string | undefined>;
  guidedSubmitInFlight: RefObject<boolean>;
  unsavedWorkRegistry: ReturnType<typeof useUnsavedWorkRegistry>;
  formBlock: ReturnType<typeof createFormBlockRuntime>;
  applyDispatch: (dispatch: Promise<FlowDispatchResult | undefined>, formPlacementId?: string, afterAccepted?: () => Promise<Notice | undefined>, sourceBindingId?: string) => Promise<unknown>;
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
  const guidedAddress = useMemo(
    () => ({
      tenantShortName: application.tenantShortName,
      organizationShortName: application.organizationShortName,
      applicationKey: application.applicationKey,
      pageKey: application.pageKey,
      ...(subject === undefined ? {} : { subjectRecordId: subject.recordId }),
    }),
    [application, subject],
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

  const advanceGuidedStep = useCallback(
    async (stepId: string, values: Readonly<Record<string, unknown>>, requested?: string) => {
      const guidedForm = model.guidedForm;
      if (guidedForm === undefined || busy || guidedFormCompleted) return;
      setBusy(true);
      setNotice(undefined);
      try {
        const result = await guidedFormActions.advance({
          address: guidedAddress,
          draftId: guidedForm.draftId,
          expectedRevision: guidedForm.revision,
          stepId,
          ...(requested === undefined ? {} : { requestedStepId: requested }),
          values,
        });
        if (result.kind === "updated" || result.kind === "unchanged") {
          if (result.kind === "updated" && !result.valid && result.activeStepId === stepId)
            setNotice({ tone: "problem", text: "Review the fields in this step before continuing." });
          const queryStep =
            result.activeStepId === result.computedStepId ? null : result.activeStepId;
          if (searchParams.get("step") === queryStep) router.refresh();
          else
            setQuery((parameters) => {
              if (queryStep === null) parameters.delete("step");
              else parameters.set("step", queryStep);
            });
          return;
        }
        if (result.kind === "conflict") {
          setNotice({ tone: "problem", text: "This draft changed in another session. Review the latest step." });
          router.refresh();
          return;
        }
        setNotice(unavailableNotice);
      } catch {
        setNotice(unavailableNotice);
      } finally {
        setBusy(false);
      }
    },
    [
      busy,
      guidedAddress,
      guidedFormActions,
      guidedFormCompleted,
      model.guidedForm,
      router,
      searchParams,
      setQuery,
    ],
  );

  const requestGuidedStep = useCallback(
    (requested?: string) => {
      const guidedForm = model.guidedForm;
      if (guidedForm === undefined || busy || guidedFormCompleted) return;
      if (requested !== undefined && guidedForm.activeStepId === guidedSummaryStepId) {
        void advanceGuidedStep(guidedForm.activeStepId, {}, requested);
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
          : [...document.querySelectorAll<HTMLFormElement>(
              'form[data-vortex-control="form-container"]',
            )].find((form) => form.dataset.vortexPlacementId === activeFormId);
      if (activeForm !== undefined) {
        activeForm.requestSubmit();
        return;
      }
      requestedStepId.current = undefined;
      void advanceGuidedStep(guidedForm.activeStepId, {}, requested);
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

  const submitGuidedSummary = useCallback(
    async (
      placementId: string,
      binding: PlacementFlowBinding,
      submittedValues: Readonly<Record<string, unknown>>,
      selectedOwnerGroupId?: string,
    ) => {
      const guidedForm = model.guidedForm;
      if (
        guidedForm === undefined ||
        guidedSummaryStepId === undefined ||
        guidedForm.activeStepId !== guidedSummaryStepId ||
        binding.flowId.toLowerCase() !== guidedForm.flowId.toLowerCase() ||
        busy ||
        guidedFormCompleted ||
        guidedSubmitInFlight.current
      )
        return;
      guidedSubmitInFlight.current = true;
      setBusy(true);
      setNotice(undefined);
      let flowStarted = false;
      try {
        const confirmed = await guidedFormActions.confirm({
          address: guidedAddress,
          draftId: guidedForm.draftId,
          expectedRevision: guidedForm.revision,
          stepId: guidedForm.activeStepId,
        });
        if (confirmed.kind !== "confirmed") {
          setNotice(
            confirmed.kind === "conflict"
              ? { tone: "problem", text: "This draft changed in another session. Review the latest step." }
              : unavailableNotice,
          );
          if (confirmed.kind === "conflict") router.refresh();
          return;
        }
        const afterAccepted = async (): Promise<Notice | undefined> => {
          unsavedWorkRegistry?.markSaved(placementId, submittedValues);
          const abandoned = await guidedFormActions.abandon({
            address: guidedAddress,
            draftId: guidedForm.draftId,
            expectedRevision: guidedForm.revision,
          });
          return abandoned.kind === "abandoned"
            ? undefined
            : {
                tone: "problem",
                text: "The submission finished, but the saved draft could not be cleared. Refresh before submitting again.",
              };
        };
        const dispatch = formBlock.submit(
          asComponentBinding(placementId, binding),
          { $guidedFormConfirmation: confirmed.proof },
          selectedOwnerGroupId,
        );
        flowStarted = true;
        await applyDispatch(dispatch, placementId, afterAccepted, binding.bindingId);
      } catch {
        setNotice(unavailableNotice);
      } finally {
        guidedSubmitInFlight.current = false;
        if (!flowStarted) setBusy(false);
      }
    },
    [
      applyDispatch,
      busy,
      formBlock,
      guidedAddress,
      guidedFormActions,
      guidedFormCompleted,
      guidedSummaryStepId,
      guidedSubmitInFlight,
      model.guidedForm,
      router,
      unsavedWorkRegistry,
    ],
  );

  return { guidedActiveFormIds, guidedActivePlacementIds, guidedSummaryStepId, submitGuidedSummary, advanceGuidedStep, guidedPreviousStepId, requestGuidedStep };
}
