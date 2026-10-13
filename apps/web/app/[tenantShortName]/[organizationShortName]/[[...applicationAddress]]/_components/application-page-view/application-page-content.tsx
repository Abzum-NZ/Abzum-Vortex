import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ApplicationAccountActionsProvider,
  type ApplicationAccount,
  type FieldInputControlReleaseMap,
  type createFullPlatformComponentRegistry,
  PagePuckRenderer,
  type PagePuckRendererProps,
  type ApplicationAccountActions,
  type ControlSemanticEvent,
  type ChoiceInputPayload,
  type DisplaySemanticEvent,
  type FormFlowFeedback,
  type ProjectedPageCapability,
  type PlatformThemeTokens,
} from "@vortex/ui";
import type { ReferenceChoiceSelectionEvidence } from "@vortex/platform/schema";
import { Button } from "@vortex/ui/components/button";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
import { Toaster, toast } from "@vortex/ui/components/sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vortex/ui/components/dialog";
import type { ApplicationPageModel } from "../../../../../_lib/application-page";
import { signOut } from "../../../../../auth/actions";
import type {
  GuidedFormActions,
  Notice,
  SubmittedForm,
  ApplicationShellRuntime,
  RefreshedPlacementData,
} from "./types";
import { formOwnersByPlacement } from "./form-surface";
import { placementEventNamesByPage, applicationLauncherPlacementIds } from "./placement-helpers";
import { useUnsavedWorkPrompt } from "./use-unsaved-work-prompt";
import { useNavigationScope } from "./use-navigation-scope";
import { usePlacementRefresh } from "./use-placement-refresh";
import { useReferenceChoices } from "./use-reference-choices";
import { useFlowRuntime } from "./use-flow-runtime";
import { useApplyDispatch } from "./use-apply-dispatch";
import { useGuidedFormSteps } from "./use-guided-form-steps";
import { usePlacementActions } from "./use-placement-actions";
import { useRuntimeInputs } from "./use-runtime-inputs";

export function ApplicationPageViewContent({
  model,
  guidedFormActions,
  onOpenApplication,
  adoptReleaseAction,
  applicationSwitcherState,
  account,
  applicationSearch,
  applicationSearchPageSubject,
  pageFeedback,
  platformComponentRegistry,
  fieldInputControlReleases,
  platformThemeTokens,
}: Readonly<{
  model: ApplicationPageModel;
  guidedFormActions: GuidedFormActions;
  onOpenApplication: (event: DisplaySemanticEvent) => Promise<void>;
  adoptReleaseAction?: ((formData: FormData) => Promise<void>) | undefined;
  applicationSwitcherState: "available" | "unavailable" | "temporarily_unavailable";
  account: ApplicationAccount;
  applicationSearch?: PagePuckRendererProps["applicationSearch"];
  applicationSearchPageSubject?: string | undefined;
  pageFeedback?: ReactNode;
  platformComponentRegistry: ReturnType<typeof createFullPlatformComponentRegistry>;
  fieldInputControlReleases: FieldInputControlReleaseMap;
  platformThemeTokens: PlatformThemeTokens;
}>): ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentSearch = searchParams.toString();
  const [selection, setSelection] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [choicePages, setChoicePages] = useState<Readonly<Record<string, ChoiceInputPayload>>>({});
  const [dialogChoicePages, setDialogChoicePages] = useState<
    Readonly<Record<string, ChoiceInputPayload>>
  >({});
  const [choicePagesOwner, setChoicePagesOwner] = useState(model);
  const activeChoicePages = choicePagesOwner === model ? choicePages : {};
  const activeDialogChoicePages = choicePagesOwner === model ? dialogChoicePages : {};
  const [refreshedPlacementData, setRefreshedPlacementData] = useState<RefreshedPlacementData | undefined>(
    undefined,
  );
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  // A confirmation is a transient toast; a problem stays on the page as an alert until dismissed
  // by the next action, so it is never missed.
  useEffect(() => {
    if (notice?.tone === "info") toast.success(notice.text);
  }, [notice]);
  const [formFeedback, setFormFeedback] = useState<Readonly<Record<string, FormFlowFeedback>>>({});
  const [busy, setBusy] = useState(false);
  const currentBusyRef = useRef(busy);
  currentBusyRef.current = busy;
  const [completedGuidedNavigationKey, setCompletedGuidedNavigationKey] = useState<string>();
  const requestedStepId = useRef<string | undefined>(undefined);
  const guidedSubmitInFlight = useRef(false);
  const runtimeInputsRef = useRef<Readonly<Record<string, unknown>>>({});
  const dialogFormRef = useRef<HTMLDivElement>(null);
  const requestChoicePageRef = useRef<
    (
      placementId: string,
      event: Extract<ControlSemanticEvent, { event: "choices_requested" }>,
      formId?: string,
    ) => Promise<void>
  >(async () => undefined);
  const choiceRequestIdsRef = useRef<Record<string, number>>({});
  const choiceSelectionsRef = useRef<Record<string, Readonly<{
    key: string;
    evidence: ReferenceChoiceSelectionEvidence;
  }>>>({});
  const choiceDefaultContextsRef = useRef<Record<string, boolean>>({});
  const submittedFormsRef = useRef(new Map<string, SubmittedForm>());
  const continuingFormsRef = useRef(new Map<string, SubmittedForm>());
  const {
    unsavedWorkRegistry,
    unsavedWork,
    leavePromptOpen,
    settleDiscardConfirmation,
  } = useUnsavedWorkPrompt({ router });

  const application = model.invocation;
  const formOwners = useMemo(
    () => formOwnersByPlacement(model.page, platformComponentRegistry),
    [model.page, platformComponentRegistry],
  );
  const placementEventNames = useMemo(
    () => placementEventNamesByPage(model.page, platformComponentRegistry),
    [model.page, platformComponentRegistry],
  );
  const launcherPlacements = useMemo(
    () => applicationLauncherPlacementIds(model.page, platformComponentRegistry),
    [model.page, platformComponentRegistry],
  );
  const {
    navigationKey,
    placementRequestsRef,
    boardContinuationInFlightRef,
    tableContinuationHistoryRef,
  } = useNavigationScope({
    model,
    pathname,
    currentSearch,
    application,
  });

  const guidedFormCompleted = completedGuidedNavigationKey === navigationKey;
  const subject =
    refreshedPlacementData?.navigationKey === navigationKey &&
    refreshedPlacementData.subject !== undefined
      ? refreshedPlacementData.subject ?? undefined
      : model.subject;
  const currentPageKey = model.pages.find(
    (page) => page.pageId.toLowerCase() === model.pageId.toLowerCase(),
  )?.key;
  const basePath = `/${encodeURIComponent(application.tenantShortName)}/${encodeURIComponent(application.organizationShortName)}/${encodeURIComponent(application.applicationKey)}`;
  const pageKeyOf = useMemo(
    () => new Map(model.pages.map((page) => [page.pageId.toLowerCase(), page.key])),
    [model.pages],
  );
  const resolvePageHref = useCallback(
    (pageId: string) => {
      const key = pageKeyOf.get(pageId.toLowerCase());
      return key === undefined ? basePath : `${basePath}/${encodeURIComponent(key)}`;
    },
    [basePath, pageKeyOf],
  );
  const {
    currentData,
    refreshPlacements,
    refreshTargetsForBinding,
    currentEditFormBaselines,
    pinActivationInFlightRef,
    currentTileDataRef,
    compositionRootRef,
  } = usePlacementRefresh({
    currentPageKey,
    placementRequestsRef,
    navigationKey,
    application,
    currentSearch,
    router,
    model,
    choiceRequestIdsRef,
    setChoicePages,
    setDialogChoicePages,
    setRefreshedPlacementData,
    refreshedPlacementData,
  });

  useEffect(() => {
    setBusy(false);
    setNotice(undefined);
    setFormFeedback({});
  }, [navigationKey]);

  const {
    choicePayloadFor,
    choiceEvidenceFor,
    changeChoiceField,
    initializeChoiceForm,
    clearChoiceForm,
    requestChoicePage,
  } = useReferenceChoices({
    setChoicePagesOwner,
    model,
    setChoicePages,
    setDialogChoicePages,
    choiceSelectionsRef,
    choiceDefaultContextsRef,
    choiceRequestIdsRef,
    activeChoicePages,
    activeDialogChoicePages,
    currentData,
    placementRequestsRef,
    application,
    router,
    setNotice,
    requestChoicePageRef,
  });

  const { formBlock, flowRuntime, intentHostElement } = useFlowRuntime({
    application,
    subject,
    continuingFormsRef,
    unsavedWorkRegistry,
    submittedFormsRef,
    router,
    resolvePageHref,
    basePath,
    unsavedWork,
    model,
    platformComponentRegistry,
    runtimeInputsRef,
    choicePayloadFor,
    choiceDefaultContextsRef,
    fieldInputControlReleases,
    choiceSelectionsRef,
    setNotice,
    choiceEvidenceFor,
    requestChoicePageRef,
    changeChoiceField,
    initializeChoiceForm,
    currentData,
    clearChoiceForm,
    dialogFormRef,
    platformThemeTokens,
  });

  /** A page's own view state (sort, filter, search) lives in its address, so it can be shared and reloaded. */
  const setQuery = useCallback(
    (change: (parameters: URLSearchParams) => void) => {
      const parameters = new URLSearchParams(searchParams.toString());
      change(parameters);
      const query = parameters.toString();
      router.replace(query === "" ? pathname : `${pathname}?${query}`);
    },
    [pathname, router, searchParams],
  );

  const { applyDispatch } = useApplyDispatch({
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
  });

  const {
    guidedActiveFormIds,
    guidedActivePlacementIds,
    guidedSummaryStepId,
    submitGuidedSummary,
    advanceGuidedStep,
    guidedPreviousStepId,
    requestGuidedStep,
  } = useGuidedFormSteps({
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
  });

  const { runBinding, continueBoardColumn, continueTablePage } = usePlacementActions({
    applyDispatch,
    flowRuntime,
    formOwners,
    busy,
    placementRequestsRef,
    navigationKey,
    currentPageKey,
    currentData,
    boardContinuationInFlightRef,
    setRefreshedPlacementData,
    refreshPlacements,
    application,
    currentSearch,
    router,
    tableContinuationHistoryRef,
  });

  const { runtimeInputs } = useRuntimeInputs({
    currentData,
    model,
    formFeedback,
    guidedActiveFormIds,
    guidedActivePlacementIds,
    guidedFormCompleted,
    placementEventNames,
    formOwners,
    launcherPlacements,
    busy,
    unsavedWork,
    onOpenApplication,
    runBinding,
    continueBoardColumn,
    continueTablePage,
    refreshPlacements,
    setSelection,
    setQuery,
    requestChoicePageRef,
    changeChoiceField,
    subject,
    requestedStepId,
    guidedSummaryStepId,
    setNotice,
    submitGuidedSummary,
    advanceGuidedStep,
    currentEditFormBaselines,
    setFormFeedback,
    choiceEvidenceFor,
    submittedFormsRef,
    applyDispatch,
    formBlock,
    initializeChoiceForm,
    selection,
    application,
    activeChoicePages,
    pinActivationInFlightRef,
    placementRequestsRef,
    navigationKey,
    currentTileDataRef,
    currentPageKey,
    currentBusyRef,
    currentSearch,
    router,
    requestChoicePage,
    runtimeInputsRef,
  });

  const releaseAdoption = model.adoption;
  const accountActions: ApplicationAccountActions = {
    account,
    organizationName: application.organizationShortName,
    ...(releaseAdoption === undefined || adoptReleaseAction === undefined
      ? {}
      : {
          releaseAdoption: {
            version: releaseAdoption.offeredReleaseVersion,
            adopt: async () => {
              const formData = new FormData();
              formData.set("applicationKey", model.invocation.applicationKey);
              formData.set("pageKey", model.invocation.pageKey);
              formData.set("targetReleaseRevision", String(releaseAdoption.offeredReleaseRevision));
              formData.set("expectedActiveReleaseRevision", String(releaseAdoption.installedReleaseRevision));
              await adoptReleaseAction(formData);
            },
          },
        }),
    chooseOrganization: async () => {
      if (unsavedWork.hasUnsavedWork() && !(await unsavedWork.confirmDiscardUnsavedWork())) return;
      router.push("/signed-in");
    },
    openApplication: async (href: string) => {
      if (unsavedWork.hasUnsavedWork() && !(await unsavedWork.confirmDiscardUnsavedWork())) return;
      router.push(href);
    },
    signOut: async () => {
      if (unsavedWork.hasUnsavedWork() && !(await unsavedWork.confirmDiscardUnsavedWork())) return;
      await signOut();
    },
  };
  const applicationShellRuntime: ApplicationShellRuntime = {
    applicationName: model.applicationName,
    applicationHref: `${basePath}/${encodeURIComponent(model.applicationHomePageKey)}`,
    organizationName: application.organizationShortName,
    pageName: model.pageName,
    applicationSwitcherState,
    applications: model.availableApplications.map((candidate) => ({
      key: candidate.key,
      name: candidate.name,
      href: `/${encodeURIComponent(application.tenantShortName)}/${encodeURIComponent(application.organizationShortName)}/${encodeURIComponent(candidate.key)}/${encodeURIComponent(candidate.homePageKey)}`,
    })),
  };

  return (
    <>
      <ApplicationAccountActionsProvider actions={accountActions}>
      <div ref={compositionRootRef} className="contents">
      <PagePuckRenderer
        overlay={<Toaster position="bottom-right" />}
        themeMode="system"
        applicationSurface
        feedback={pageFeedback === undefined && (notice === undefined || notice.tone === "info") &&
          model.bodyContentAvailable !== false ? undefined : (
          <>
            {pageFeedback}
            {model.bodyContentAvailable !== false ? null : (
              <Alert role="status" aria-live="polite">
                <AlertDescription>No page content is available.</AlertDescription>
              </Alert>
            )}
            {notice === undefined || notice.tone === "info" ? null : (
              <Alert
                variant={notice.tone === "problem" ? "destructive" : "default"}
                role={notice.tone === "problem" ? "alert" : "status"}
                aria-live="polite"
                data-vortex-notice={notice.tone}
              >
                <AlertDescription>{notice.text}</AlertDescription>
              </Alert>
            )}
          </>
        )}
        composition={model.page as unknown as ProjectedPageCapability}
        registry={platformComponentRegistry}
        fieldInputControlReleases={fieldInputControlReleases}
        platformThemeTokens={platformThemeTokens}
        shells={model.shells}
        {...(model.applicationShell === undefined ? {} : { shell: model.applicationShell })}
        applicationShellRuntime={applicationShellRuntime}
        applicationSearch={applicationSearch}
        applicationSearchPageSubject={applicationSearchPageSubject}
        pageId={model.pageId}
        theme={model.theme}
        projectedNavigation={model.navigation}
        resolvePageHref={resolvePageHref}
        currentPageId={model.pageId}
        {...(model.guidedForm === undefined
          ? {}
          : {
              activeStepId: model.guidedForm.activeStepId,
              guidedSummaryValues: model.guidedForm.values,
            })}
        runtimeInputs={runtimeInputs}
        {...(model.guidedForm === undefined
          ? {}
          : {
              guidedStepNavigation: {
                  disabled: busy || guidedFormCompleted,
                  onBack: () => {
                    if (guidedPreviousStepId !== undefined)
                      requestGuidedStep(guidedPreviousStepId);
                  },
                  onNext: () => requestGuidedStep(),
              },
            })}
      />
      </div>
      </ApplicationAccountActionsProvider>
      {intentHostElement}
      <Dialog
        open={leavePromptOpen}
        disablePointerDismissal
        onOpenChange={(open) => {
          if (!open) settleDiscardConfirmation(false);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Leave this page?</DialogTitle>
            <DialogDescription>Your unsaved changes will be lost.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row">
            <Button
              type="button"
              variant="secondary"
              autoFocus
              onClick={() => settleDiscardConfirmation(false)}
            >
              Stay
            </Button>
            <Button type="button" onClick={() => settleDiscardConfirmation(true)}>
              Leave
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
