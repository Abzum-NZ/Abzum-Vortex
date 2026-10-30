import {
  use,
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
  type createPlatformComponentRegistryForReleases,
  PagePuckRenderer,
  type FlowIntentHost,
  type ServerDrivenResult,
  type DisplaySemanticEvent,
  type RenderedPage,
  type PlatformThemeTokens,
  type ApplicationWebMcpRuntime,
  isClientPageChange,
  pageHoldFor,
  primaryStreamedPlacement,
  createFlowRuntimeState,
} from "@vortex/ui";
import {
  describeFailure,
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  type ProjectedApplicationFrame,
  type PageDefinition,
  isRecord,
  walkPageComposition,
  readCompiledItemSettings,
} from "@vortex/platform/schema";
import Link from "next/link";
import { Button } from "@vortex/ui/components/button";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
import { FirstRecordTypeEmptyState } from "../../../../../../_components/first-record-type-empty-state";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import type { PageWebMcpTool } from "../../../../../../_lib/application-page";
import type {
  GuidedFormActions,
  PageMessageDraft,
  SubmittedForm,
  RefreshedPlacementData,
  PageSelection,
} from "./types";
import { ownersByPlacement } from "./form-surface";
import { placementEventNamesByPage, applicationLauncherPlacementIds } from "./placement-helpers";
import { useUnsavedWorkPrompt } from "./use-unsaved-work-prompt";
import { useNavigationScope } from "./use-navigation-scope";
import { usePlacementRefresh } from "./use-placement-refresh";
import { useFlowRuntime } from "./use-flow-runtime";
import { useFieldFlowEvents } from "./use-field-flow-events";
import { useApplyDispatch } from "./use-apply-dispatch";
import { useGuidedFormSteps } from "./use-guided-form-steps";
import { usePlacementActions } from "./use-placement-actions";
import { useTablePageAddress } from "./use-table-page-address";
import { usePageAddress } from "./page-address";
import { useRuntimeInputs } from "./use-runtime-inputs";
import { draftControls } from "./control-drafts";
import { useGridLayout } from "./use-grid-layout";
import { useRowDetail } from "./use-row-detail";
import { usePivot } from "./use-pivot";
import { useGroupMembers } from "./use-group-members";
import { WebMcpAdapter } from "../../../../../../_components/webmcp-adapter";
import {
  useApplicationFrame,
  useFramePageState,
  emptyControlDrafts,
} from "../../../_components/application-frame-state";

/** Every placement id of the page's own content, nested placements and guided step content included. */
const placementIdsOf = (content: Readonly<Record<string, unknown>>): ReadonlySet<string> => {
  const ids = new Set<string>();
  walkPageComposition(content.composition, ({ placementId }) => {
    ids.add(placementId);
    return undefined;
  });
  return ids;
};

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
  platformComponentRegistry: ReturnType<typeof createPlatformComponentRegistryForReleases>;
  fieldInputControlReleases: FieldInputControlReleaseMap;
  platformThemeTokens: PlatformThemeTokens;
}>): ReactElement {
  // Hold then swap: a page that arrives after the document has loaded waits, inside the page
  // change's transition (so the current page stays on screen), for its primary placement's data or
  // the page hold, whichever comes first. The data is the same response's streamed read, so the
  // wait never costs a request. A page released by the hold shows its skeleton at once.
  const primaryPlacementId =
    model.streamedData === undefined
      ? undefined
      : primaryStreamedPlacement(content, model.streamedData);
  const primaryRead =
    primaryPlacementId === undefined ? undefined : model.streamedData?.[primaryPlacementId];
  const pageHold =
    primaryRead !== undefined && isClientPageChange() ? use(pageHoldFor(primaryRead)) : "ready";
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const runtimeStateRef = useRef<{
    identity: string;
    state: ReturnType<typeof createFlowRuntimeState>;
  } | null>(null);
  const pageIdentity = `${model.pageId}:${model.invocation.releaseKey}`;
  if (runtimeStateRef.current?.identity !== pageIdentity)
    runtimeStateRef.current = {
      identity: pageIdentity,
      state: createFlowRuntimeState((model.page as PageDefinition).values, model.formTypes),
    };
  const runtimeState = runtimeStateRef.current.state;
  runtimeState.setFormTypes(model.formTypes);
  useEffect(() => () => runtimeState.messages.dispose(), [runtimeState]);
  // The page address owns every table's query state; the served address only starts it.
  const { address, currentSearch } = usePageAddress({ model, served: searchParams.toString() });
  const [selection, setSelection] = useState<PageSelection>({});
  const [refreshedPlacementData, setRefreshedPlacementData] = useState<
    RefreshedPlacementData | undefined
  >(undefined);
  const showPageMessage = useCallback<(message: PageMessageDraft | undefined) => void>(
    (message) => {
      runtimeState.messages.clear("banner");
      runtimeState.messages.clear("toast");
      if (message !== undefined)
        runtimeState.messages.show({ ...message, id: crypto.randomUUID() });
    },
    [runtimeState],
  );
  const [webMcpShellState, setWebMcpShellState] = useState<ApplicationWebMcpRuntime>();
  const reportWebMcpShellState = useCallback(
    (runtime: ApplicationWebMcpRuntime | undefined) => setWebMcpShellState(runtime),
    [],
  );
  const applicationFrame = useApplicationFrame();
  const controlDraftsRef = applicationFrame?.controlDraftsRef;
  const navigation = model.navigation ?? applicationFrame?.navigation;
  // A page rendered without its frame (the layout found none for the address it first loaded)
  // asks the server once for the frame of the address it shows now.
  const frameRequested = useRef(false);
  useEffect(() => {
    if (applicationFrame !== null || frameRequested.current) return;
    frameRequested.current = true;
    router.refresh();
  }, [applicationFrame, router]);
  const [guidedBusy, setGuidedBusy] = useState(false);
  const [completedGuidedNavigationKey, setCompletedGuidedNavigationKey] = useState<string>();
  const requestedStepId = useRef<string | undefined>(undefined);
  const guidedSubmitInFlight = useRef(false);
  const runtimeInputsRef = useRef<Readonly<Record<string, unknown>>>({});
  const setPanelRef = useRef<FlowIntentHost["setPanel"]>(undefined);
  const dialogFormRef = useRef<HTMLDivElement>(null);
  const submittedFormsRef = useRef(new Map<string, SubmittedForm>());
  const continuingFormsRef = useRef(new Map<string, SubmittedForm>());
  /** Set when the person cancels a form a running flow paused at; a board move clears it when it starts. */
  const formCancelledRef = useRef(false);
  const { unsavedWorkRegistry, unsavedWork, confirmDialog } = useUnsavedWorkPrompt({ router });

  const application = model.invocation;
  const formOwners = useMemo(
    () =>
      ownersByPlacement(
        model.page,
        platformComponentRegistry,
        PLATFORM_BLOCK_RELEASE_IDENTITIES.FORM_CONTAINER_BLOCK_RELEASE,
      ),
    [model.page, platformComponentRegistry],
  );
  const recordDetailOwners = useMemo(
    () =>
      ownersByPlacement(
        model.page,
        platformComponentRegistry,
        PLATFORM_BLOCK_RELEASE_IDENTITIES.RECORD_DETAIL_BLOCK_RELEASE,
      ),
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
    addressKey,
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
  // Running gestures and kept retry identities belong to the page address they started on.
  useEffect(() => () => runtimeState.dispose(), [runtimeState, addressKey]);
  if (controlDraftsRef !== undefined && controlDraftsRef.current.scope !== addressKey)
    controlDraftsRef.current = {
      ...emptyControlDrafts(),
      scope: addressKey,
      model,
    };

  const guidedFormCompleted = completedGuidedNavigationKey === navigationKey;
  const subject =
    refreshedPlacementData?.navigationKey === navigationKey &&
    refreshedPlacementData.subject !== undefined
      ? (refreshedPlacementData.subject ?? undefined)
      : model.subject;
  // An action's write re-projects the page's placements on the server (a control follows its action's
  // availability); until then the content the page was sent with stands.
  const currentContent =
    refreshedPlacementData?.navigationKey === navigationKey &&
    refreshedPlacementData.content !== undefined
      ? refreshedPlacementData.content
      : content;
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
    prepareFlowRefresh,
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
    address,
    router,
    model,
    setRefreshedPlacementData,
    refreshedPlacementData,
  });

  useEffect(() => {
    setGuidedBusy(false);
    showPageMessage(undefined);
    runtimeState.messages.clearAll();
  }, [navigationKey]);

  const applyMessageActionRef = useRef<
    (dispatch: Promise<ServerDrivenResult>, bindingId: string) => void
  >(() => undefined);
  const { formBlock, flowRuntime, webMcpRuntime, intentHostElement, messageBanner } =
    useFlowRuntime({
      application,
      runtimeState,
      subject,
      continuingFormsRef,
      formCancelledRef,
      unsavedWorkRegistry,
      submittedFormsRef,
      router,
      resolvePageHref,
      basePath,
      unsavedWork,
      model,
      platformComponentRegistry,
      runtimeInputsRef,
      controlDraftsRef,
      fieldInputControlReleases,
      showPageMessage,
      currentData,
      dialogFormRef,
      platformThemeTokens,
      prepareRefresh: (bindingId) => {
        let targets = refreshTargetsForBinding(bindingId);
        if (targets.length === 0) {
          // Identity and Access writes have no record target. Only reread displayed data:
          // the page payload also holds inputs for dialogs that are not part of this projection.
          const displayed = new Set(
            Array.from(
              compositionRootRef.current?.querySelectorAll<HTMLElement>(
                "[data-vortex-placement-id]",
              ) ?? [],
            )
              .filter((element) => element.getClientRects().length > 0)
              .map((element) => element.dataset.vortexPlacementId?.toLowerCase()),
          );
          targets = Object.keys(currentData).filter((id) => displayed.has(id.toLowerCase()));
        }
        return prepareFlowRefresh(targets);
      },
      setPanelRef,
      applyMessageActionRef,
    });

  /** A page-level address change (a guided form step) renders the page again on the server. */
  const setQuery = useCallback(
    (change: (parameters: URLSearchParams) => void) => {
      const parameters = new URLSearchParams(address.search());
      change(parameters);
      const query = parameters.toString();
      router.replace(query === "" ? pathname : `${pathname}?${query}`);
    },
    [address, pathname, router],
  );

  const { applyDispatch } = useApplyDispatch({
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
  });
  applyMessageActionRef.current = (dispatch, bindingId) => {
    void applyDispatch(dispatch, undefined, undefined, bindingId);
  };

  const invokeWebMcpTool = useCallback(
    async (tool: PageWebMcpTool, input: unknown, signal?: AbortSignal): Promise<unknown> => {
      if (signal?.aborted) return { outcome: "cancelled" };
      if (!isRecord(input)) return { outcome: "refused" };
      showPageMessage(undefined);
      try {
        const result = await webMcpRuntime.dispatchReference(
          tool.binding,
          input,
          crypto.randomUUID(),
          signal,
        );
        await applyDispatch(Promise.resolve(result), undefined, undefined, tool.binding.bindingId);
        if (signal?.aborted) return { outcome: "cancelled" };
        if (result.kind === "finished")
          return {
            outcome: result.descriptor.outcome,
            ...(result.descriptor.outputs === "available" ? { outputs: result.outputs } : {}),
          };
        return { outcome: result.kind };
      } catch (error) {
        console.error(`[webmcp] flow dispatch failed for ${tool.name}: ${describeFailure(error)}`);
        return { outcome: "unavailable" };
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
    prepareGuidedSummary,
    advanceGuidedStep,
    guidedPreviousStepId,
    requestGuidedStep,
  } = useGuidedFormSteps({
    model,
    formOwners,
    application,
    subject,
    busy: guidedBusy,
    guidedFormCompleted,
    setBusy: setGuidedBusy,
    showPageMessage,
    guidedFormActions,
    searchParams,
    router,
    setQuery,
    requestedStepId,
    guidedSubmitInFlight,
    unsavedWorkRegistry,
  });

  const {
    commitTablePage,
    changeTableQuery,
    commitPivotView,
    openTableView,
    selectTableViewInPlace,
    tableQueryPending,
    rereadTables,
    tableData,
  } = useTablePageAddress({
    model,
    address,
    currentSearch,
    currentData,
    refreshPlacements,
    setSelection,
  });
  const { runBinding, readBoardColumns, continueTablePage } = usePlacementActions({
    applyDispatch,
    flowRuntime,
    formOwners,
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
    tableQueryPending,
  });

  const { commitLayout, runViewCommand } = useGridLayout({
    model,
    currentData,
    navigationKey,
    setRefreshedPlacementData,
    openTableView,
    selectTableViewInPlace,
    refreshPlacements,
    pageAddress: address,
  });
  const { readDetail: readRowDetail } = useRowDetail({
    application,
    currentPageKey,
    currentSearch,
    onReload: router.refresh,
  });
  const { readPivotPage } = usePivot({
    application,
    currentPageKey,
    currentSearch,
    onReload: router.refresh,
  });

  const { groupEventsFor } = useGroupMembers({
    application,
    currentPageKey,
    address,
    onReload: router.refresh,
    changeTableQuery,
  });

  const controls = useMemo(
    () => draftControls(currentContent, platformComponentRegistry, fieldInputControlReleases),
    [currentContent, platformComponentRegistry, fieldInputControlReleases],
  );
  const drafts = controlDraftsRef?.current;
  if (drafts !== undefined && drafts.model !== model) {
    drafts.model = model;
    if (Object.keys(drafts.drafts).length === 0) {
      drafts.restored = {};
      delete drafts.pending;
      delete drafts.restoreBaselines;
    } else {
      const promise = import("./restore-control-drafts").then(
        ({ restoreDrafts, restoreBaselines }) => {
          if (controlDraftsRef?.current !== drafts || drafts.pending !== promise) return;
          restoreDrafts(drafts, controls, tableData, formOwners);
          drafts.restoreBaselines = restoreBaselines(drafts);
          delete drafts.pending;
        },
      );
      drafts.pending = promise;
    }
  }
  if (drafts?.pending !== undefined) use(drafts.pending);
  useEffect(() => {
    if (unsavedWorkRegistry !== undefined)
      controlDraftsRef?.current.restoreBaselines?.(unsavedWorkRegistry);
  }, [navigationKey, model, controlDraftsRef, unsavedWorkRegistry]);

  const fieldFlowEvents = useFieldFlowEvents(
    navigationKey,
    runtimeState,
    runBinding,
    showPageMessage,
  );
  const { runtimeInputs } = useRuntimeInputs({
    currentData: tableData,
    model,
    runtimeState,
    guidedActiveFormIds,
    guidedActivePlacementIds,
    guidedFormCompleted,
    placementEventNames,
    formOwners,
    recordDetailOwners,
    launcherPlacements,
    unsavedWork,
    onOpenApplication,
    runBinding,
    fieldFlowEvents,
    readBoardColumns,
    continueTablePage,
    refreshPlacements,
    setSelection,
    changeTableQuery,
    commitLayout,
    runViewCommand,
    readRowDetail,
    readPivotPage,
    commitPivotView,
    groupEventsFor,
    subject,
    requestedStepId,
    guidedSummaryStepId,
    showPageMessage,
    prepareGuidedSummary,
    advanceGuidedStep,
    currentEditFormBaselines,
    submittedFormsRef,
    formCancelledRef,
    applyDispatch,
    formBlock,
    selection,
    application,
    pinActivationInFlightRef,
    placementRequestsRef,
    navigationKey,
    currentTileDataRef,
    currentPageKey,
    currentSearch,
    address,
    rereadTables,
    router,
    runtimeInputsRef,
    controlDraftsRef,
    controls,
    unsavedWorkRegistry,
    setPanelRef,
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
  const contentPlacementIds = useMemo(() => placementIdsOf(content), [content]);
  // A placement the server no longer projects (its action is unavailable now) keeps its wiring in
  // the runtime, but the content renderer must not be handed an input for it.
  const currentContentPlacementIds = useMemo(
    () => (currentContent === content ? contentPlacementIds : placementIdsOf(currentContent)),
    [content, contentPlacementIds, currentContent],
  );
  // A placement that only became available after the page loaded has no runtime wiring (its
  // action, form and data callbacks come from the page's first projection): one full refresh
  // rebuilds the wiring, so such a control is never visible but inert.
  const unwiredContentRefreshRef = useRef<ReadonlySet<string> | undefined>(undefined);
  useEffect(() => {
    if (currentContent === content) return;
    for (const placementId of currentContentPlacementIds) {
      if (contentPlacementIds.has(placementId)) continue;
      if (unwiredContentRefreshRef.current === currentContentPlacementIds) return;
      unwiredContentRefreshRef.current = currentContentPlacementIds;
      router.refresh();
      return;
    }
  }, [content, contentPlacementIds, currentContent, currentContentPlacementIds, router]);
  const [contentRuntimeInputs, frameRuntimeInputs] = useMemo(() => {
    const own: Record<string, unknown> = {};
    const shell: Record<string, unknown> = {};
    for (const [placementId, input] of Object.entries(runtimeInputs)) {
      if (!contentPlacementIds.has(placementId)) shell[placementId] = input;
      else if (currentContentPlacementIds.has(placementId)) own[placementId] = input;
    }
    return [own, Object.keys(shell).length === 0 ? undefined : shell] as const;
  }, [contentPlacementIds, currentContentPlacementIds, runtimeInputs]);
  useFramePageState("runtimeInputs", frameRuntimeInputs);
  const adoptRelease = useMemo(
    () =>
      adoptReleaseAction === undefined
        ? undefined
        : async (offeredReleaseRevision: number, installedReleaseRevision: number) => {
            const formData = new FormData();
            formData.set("applicationKey", application.applicationKey);
            formData.set("pageKey", application.pageKey);
            formData.set("pageParameters", address.search());
            formData.set("targetReleaseRevision", String(offeredReleaseRevision));
            formData.set("expectedActiveReleaseRevision", String(installedReleaseRevision));
            await adoptReleaseAction(formData);
          },
    [adoptReleaseAction, address, application.applicationKey, application.pageKey],
  );
  useFramePageState("adoptRelease", adoptRelease);

  return (
    <>
      <div
        ref={compositionRootRef}
        className="contents"
        {...(pageHold === "held" ? { "data-vortex-page-held": "" } : {})}
      >
        <WebMcpAdapter
          contextKey={webMcpContextKey}
          tools={model.webMcpTools}
          onInvoke={invokeWebMcpTool}
          onStatusChange={reportWebMcpShellState}
        />
        <PagePuckRenderer
          readSettings={readCompiledItemSettings}
          contentRegion
          feedback={
            <>
              {messageBanner}
              {pageFeedback}
              {model.bodyContentAvailable !== false ? null : model.firstRecordTypeHref !==
                undefined ? (
                <FirstRecordTypeEmptyState
                  action={
                    <Button nativeButton={false} render={<Link href={model.firstRecordTypeHref} />}>
                      Open the Data tab in Studio
                    </Button>
                  }
                />
              ) : (
                <Alert role="status" aria-live="polite">
                  <AlertDescription>No page content is available.</AlertDescription>
                </Alert>
              )}
            </>
          }
          composition={currentContent as unknown as RenderedPage}
          registry={platformComponentRegistry}
          fieldInputControlReleases={fieldInputControlReleases}
          platformThemeTokens={platformThemeTokens}
          applicationSearch={applicationFrame?.applicationSearch}
          applicationSearchPageSubject={applicationFrame?.applicationSearchPageSubject}
          locale={applicationFrame?.locale}
          timeZone={applicationFrame?.timeZone}
          pageId={model.pageId}
          theme={model.theme}
          {...(navigation === undefined ? {} : { projectedNavigation: navigation })}
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
          runtimeState={runtimeState}
          {...(model.guidedForm === undefined
            ? {}
            : {
                guidedStepNavigation: {
                  disabled: guidedBusy || guidedFormCompleted,
                  onBack: () => {
                    if (guidedPreviousStepId !== undefined) requestGuidedStep(guidedPreviousStepId);
                  },
                  onNext: () => requestGuidedStep(),
                },
              })}
        />
      </div>
      {intentHostElement}
      {confirmDialog}
    </>
  );
}
