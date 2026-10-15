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
  type FieldInputControlReleaseMap,
  type createFullPlatformComponentRegistry,
  PagePuckRenderer,
  type ControlSemanticEvent,
  type ChoiceInputPayload,
  type DisplaySemanticEvent,
  type FormFlowFeedback,
  type ProjectedPageCapability,
  type PlatformThemeTokens,
  type ApplicationWebMcpRuntime,
} from "@vortex/ui";
import {
  describeFailure,
  type ProjectedApplicationFrame,
  type ReferenceChoiceSelectionEvidence,
  isRecord,
} from "@vortex/platform/schema";
import { Button } from "@vortex/ui/components/button";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
import { toast } from "@vortex/ui/components/sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vortex/ui/components/dialog";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import type { PageWebMcpTool } from "../../../../../../_lib/application-page";
import type {
  GuidedFormActions,
  Notice,
  SubmittedForm,
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
import { useTablePageAddress } from "./use-table-page-address";
import { useRuntimeInputs } from "./use-runtime-inputs";
import { WebMcpAdapter } from "../../../../../../_components/webmcp-adapter";
import { useApplicationFrame, useFramePageState } from "../../../_components/application-frame-state";

export function ApplicationPageViewContent({
  model,
  content,
  frame,
  guidedFormActions,
  onOpenApplication,
  adoptReleaseAction,
  pageFeedback,
  platformComponentRegistry,
  fieldInputControlReleases,
  platformThemeTokens,
}: Readonly<{
  model: ApplicationPageModel;
  /** The page's own placements, rendered in the frame's outlet. */
  content: Readonly<Record<string, unknown>>;
  /** The frame projected with this page, handed to the application frame around it. */
  frame: ProjectedApplicationFrame;
  guidedFormActions: GuidedFormActions;
  onOpenApplication: (event: DisplaySemanticEvent) => Promise<void>;
  adoptReleaseAction?: ((formData: FormData) => Promise<void>) | undefined;
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
  const [refreshedPlacementData, setRefreshedPlacementData] = useState<
    RefreshedPlacementData | undefined
  >(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  // A confirmation is a transient toast; a problem stays on the page as an alert until dismissed
  // by the next action, so it is never missed.
  useEffect(() => {
    if (notice?.tone === "info") toast.success(notice.text);
  }, [notice]);
  const [formFeedback, setFormFeedback] = useState<Readonly<Record<string, FormFlowFeedback>>>({});
  const [webMcpShellState, setWebMcpShellState] = useState<ApplicationWebMcpRuntime>();
  const reportWebMcpShellState = useCallback(
    (runtime: ApplicationWebMcpRuntime | undefined) => setWebMcpShellState(runtime),
    [],
  );
  const applicationFrame = useApplicationFrame();
  // A page rendered without its frame (the layout found none for the address it first loaded)
  // asks the server once for the frame of the address it shows now.
  const frameRequested = useRef(false);
  useEffect(() => {
    if (applicationFrame !== null || frameRequested.current) return;
    frameRequested.current = true;
    router.refresh();
  }, [applicationFrame, router]);
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
  const choiceSelectionsRef = useRef<
    Record<
      string,
      Readonly<{
        key: string;
        evidence: ReferenceChoiceSelectionEvidence;
      }>
    >
  >({});
  const choiceDefaultContextsRef = useRef<Record<string, boolean>>({});
  const submittedFormsRef = useRef(new Map<string, SubmittedForm>());
  const continuingFormsRef = useRef(new Map<string, SubmittedForm>());
  const { unsavedWorkRegistry, unsavedWork, leavePromptOpen, settleDiscardConfirmation } =
    useUnsavedWorkPrompt({ router });

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
    tableContinuationScopeRef,
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
      ? (refreshedPlacementData.subject ?? undefined)
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

  const { formBlock, flowRuntime, webMcpRuntime, intentHostElement } = useFlowRuntime({
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

  const invokeWebMcpTool = useCallback(
    async (tool: PageWebMcpTool, input: unknown, signal?: AbortSignal): Promise<unknown> => {
      if (signal?.aborted) return { outcome: "cancelled" };
      if (currentBusyRef.current) return { outcome: "busy" };
      if (!isRecord(input)) return { outcome: "refused" };
      currentBusyRef.current = true;
      setBusy(true);
      setNotice(undefined);
      try {
        const dispatch = await webMcpRuntime.dispatchReference(
          tool.binding,
          input,
          undefined,
          signal,
        );
        await applyDispatch(
          Promise.resolve(dispatch),
          undefined,
          undefined,
          tool.binding.bindingId,
        );
        if (signal?.aborted) return { outcome: "cancelled" };
        if (dispatch.ranIn !== "server") return { outcome: "unavailable" };
        const result = dispatch.result;
        if (result.kind === "finished")
          return {
            outcome: result.descriptor.outcome,
            ...(result.descriptor.outputs === "available" ? { outputs: result.outputs } : {}),
          };
        return { outcome: result.kind };
      } catch (error) {
        console.error(`[webmcp] flow dispatch failed for ${tool.name}: ${describeFailure(error)}`);
        return { outcome: "unavailable" };
      } finally {
        currentBusyRef.current = false;
        setBusy(false);
      }
    },
    [applyDispatch, webMcpRuntime],
  );

  const webMcpContextKey = JSON.stringify([
    model.accessVersion,
    application.tenantShortName,
    application.organizationShortName,
    application.applicationKey,
    application.pageKey,
    application.installationRevision,
    application.releaseKey,
  ]);

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

  const { commitTablePage } = useTablePageAddress({ model, currentSearch, refreshPlacements });
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
    tableContinuationScopeRef,
    commitTablePage,
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

  // What the frame around this page shows for it: its breadcrumb name, its agent-tool state, its
  // unsaved-work guard, the release it offers and the frame projected with it.
  const framePage = useMemo(
    () => ({ pageId: model.pageId, name: model.pageName }),
    [model.pageId, model.pageName],
  );
  useFramePageState("page", framePage);
  useFramePageState("webMcp", webMcpShellState);
  useFramePageState("unsavedWork", unsavedWork);
  useFramePageState("frame", frame);
  useFramePageState("navigation", model.navigation);
  // The runtime wires every placement of the page's projection. The content renders its own
  // placements; the frame renders the shell's, so it receives their inputs.
  const contentPlacementIds = useMemo(() => {
    const ids = new Set<string>();
    const visit = (slot: unknown): void => {
      if (!isRecord(slot) || !isRecord(slot.placements)) return;
      for (const [placementId, placement] of Object.entries(slot.placements)) {
        ids.add(placementId);
        if (isRecord(placement) && isRecord(placement.slots))
          for (const child of Object.values(placement.slots)) visit(child);
      }
    };
    const composition = content.composition;
    if (isRecord(composition)) {
      visit(composition.main);
      if (isRecord(composition.stepContent))
        for (const step of Object.values(composition.stepContent)) visit(step);
    }
    return ids;
  }, [content]);
  const [contentRuntimeInputs, frameRuntimeInputs] = useMemo(() => {
    const own: Record<string, unknown> = {};
    const shell: Record<string, unknown> = {};
    for (const [placementId, input] of Object.entries(runtimeInputs))
      (contentPlacementIds.has(placementId) ? own : shell)[placementId] = input;
    return [own, Object.keys(shell).length === 0 ? undefined : shell] as const;
  }, [contentPlacementIds, runtimeInputs]);
  useFramePageState("runtimeInputs", frameRuntimeInputs);
  const releaseAdoption = model.adoption;
  const adoption = useMemo(
    () =>
      releaseAdoption === undefined || adoptReleaseAction === undefined
        ? undefined
        : {
            version: releaseAdoption.offeredReleaseVersion,
            adopt: async () => {
              const formData = new FormData();
              formData.set("applicationKey", application.applicationKey);
              formData.set("pageKey", application.pageKey);
              formData.set("targetReleaseRevision", String(releaseAdoption.offeredReleaseRevision));
              formData.set(
                "expectedActiveReleaseRevision",
                String(releaseAdoption.installedReleaseRevision),
              );
              await adoptReleaseAction(formData);
            },
          },
    [adoptReleaseAction, application.applicationKey, application.pageKey, releaseAdoption],
  );
  useFramePageState("releaseAdoption", adoption);

  return (
    <>
      <div ref={compositionRootRef} className="contents">
          <WebMcpAdapter
            contextKey={webMcpContextKey}
            tools={model.webMcpTools}
            onInvoke={invokeWebMcpTool}
            onStatusChange={reportWebMcpShellState}
          />
          <PagePuckRenderer
            contentRegion
            feedback={
              pageFeedback === undefined &&
              (notice === undefined || notice.tone === "info") &&
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
              )
            }
            composition={content as unknown as ProjectedPageCapability}
            registry={platformComponentRegistry}
            fieldInputControlReleases={fieldInputControlReleases}
            platformThemeTokens={platformThemeTokens}
            applicationSearch={applicationFrame?.applicationSearch}
            applicationSearchPageSubject={applicationFrame?.applicationSearchPageSubject}
            pageId={model.pageId}
            theme={model.theme}
            projectedNavigation={model.navigation}
            resolvePageHref={resolvePageHref}
            {...(applicationFrame === null
              ? {}
              : { onNavigatePage: applicationFrame.navigateToPage })}
            currentPageId={model.pageId}
            {...(model.guidedForm === undefined
              ? {}
              : {
                  activeStepId: model.guidedForm.activeStepId,
                  guidedSummaryValues: model.guidedForm.values,
                })}
            runtimeInputs={contentRuntimeInputs}
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
