import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import type { useRouter } from "next/navigation";
import type { useUnsavedWorkGuard, useUnsavedWorkRegistry } from "@vortex/ui";
import {
  createFlowInvokeClient,
  createFlowRuntime,
  createFormBlockRuntime,
  getAccessibleName,
  type FieldInputControlReleaseMap,
  type createPlatformComponentRegistryForReleases,
  PagePuckRenderer,
  scopeFlowRuntimeForms,
  UnsavedWorkProvider,
  useFlowIntentHost,
  type ControlSemanticEvent,
  type FlowFormAnswer,
  type FlowFormIntent,
  type FlowIntentHost,
  type FlowMessageIntent,
  type FlowRuntimeState,
  type FlowInvokeClient,
  type FlowDispatchResult,
  type LinkNavigationEnvironment,
  type PlatformThemeTokens,
} from "@vortex/ui";
import {
  formContinuationAnswerSchema,
  type ComponentFlowBinding,
  isRecord,
  sameId,
  readCompiledItemSettings,
} from "@vortex/platform/schema";
import { Button } from "@vortex/ui/components/button";
import { DialogFooter } from "@vortex/ui/components/dialog";
import { useApplicationFrame } from "../../../_components/application-frame-state";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import type { SubmittedForm, PageMessageDraft } from "./types";
import type { ControlDrafts } from "../../../_components/application-frame-state";
import { formSurfaceComposition, runtimeInputWithFormDefault } from "./form-surface";
import { unavailableNotice } from "./notices";

export function useFlowRuntime({
  application,
  runtimeState,
  subject,
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
  prepareRefresh,
  setPanelRef,
  applyMessageActionRef,
}: Readonly<{
  application: ApplicationPageModel["invocation"];
  runtimeState: FlowRuntimeState;
  subject: ApplicationPageModel["subject"];
  /** Set when the person cancels a form a running flow shows; a board move reads it. */
  formCancelledRef: RefObject<boolean>;
  unsavedWorkRegistry: ReturnType<typeof useUnsavedWorkRegistry>;
  submittedFormsRef: RefObject<Map<string, SubmittedForm>>;
  router: ReturnType<typeof useRouter>;
  resolvePageHref: (pageId: string) => string;
  basePath: string;
  unsavedWork: ReturnType<typeof useUnsavedWorkGuard>["guard"];
  model: ApplicationPageModel;
  platformComponentRegistry: ReturnType<typeof createPlatformComponentRegistryForReleases>;
  runtimeInputsRef: RefObject<Readonly<Record<string, unknown>>>;
  controlDraftsRef: RefObject<ControlDrafts> | undefined;
  fieldInputControlReleases: FieldInputControlReleaseMap;
  showPageMessage: (message: PageMessageDraft | undefined) => void;
  currentData: ApplicationPageModel["data"];
  dialogFormRef: RefObject<HTMLDivElement | null>;
  platformThemeTokens: PlatformThemeTokens;
  prepareRefresh: (
    bindingId: string,
  ) => Readonly<{ request: unknown; apply: (result: unknown) => void }> | undefined;
  /** Filled by the page's panel host once it has rendered. */
  setPanelRef: RefObject<FlowIntentHost["setPanel"]>;
  applyMessageActionRef: RefObject<
    (dispatch: Promise<FlowDispatchResult>, bindingId: string) => void
  >;
}>) {
  /**
   * The one browser flow client and host: the page runner carries out the flow's page steps
   * (another form or a confirmation) itself and sends each server segment to the endpoint.
   */
  const prepareRefreshRef = useRef(prepareRefresh);
  prepareRefreshRef.current = prepareRefresh;
  const { flowClient, agentClient, beginSubmission } = useMemo(() => {
    const options = {
      address: {
        tenantShortName: application.tenantShortName,
        organizationShortName: application.organizationShortName,
        applicationKey: application.applicationKey,
        pageKey: application.pageKey,
        ...(subject === undefined ? {} : { pageRecordId: subject.recordId }),
      },
      prepareRefresh: (bindingId: string) => prepareRefreshRef.current(bindingId),
      pageInputs: () => {
        const search = new URLSearchParams(window.location.search);
        const parameters: Record<string, string | string[]> = {};
        for (const name of search.keys()) {
          const values = search.getAll(name);
          parameters[name] = values.length === 1 ? values[0]! : values;
        }
        const controls: Record<string, string> = {};
        const forward = (placementId: string, value: unknown) => {
          if (value === null) controls[placementId] = "";
          else if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          )
            controls[placementId] = String(value);
          else if (isRecord(value) && typeof value.recordId === "string")
            controls[placementId] = value.recordId;
        };
        for (const [placementId, input] of Object.entries(runtimeInputsRef.current)) {
          if (!isRecord(input) || !isRecord(input.data) || input.data.status !== "ready") continue;
          const values = input.data.values;
          if (!isRecord(values)) continue;
          forward(placementId, values.value);
        }
        for (const [placementId, draft] of Object.entries(controlDraftsRef?.current.drafts ?? {}))
          forward(placementId, draft.value);
        return { parameters, controls };
      },
      ...(subject === undefined ? {} : { subject }),
    };
    const submissions = new Map<string, SubmittedForm>();
    const beginSubmission = (bindingId: string, clickId: string) => {
      const submission = submittedFormsRef.current.get(bindingId);
      submittedFormsRef.current.delete(bindingId);
      if (submission !== undefined) submissions.set(clickId, submission);
      return () => {
        if (submissions.get(clickId) === submission) submissions.delete(clickId);
      };
    };
    const wrap = async () => {
      const { trackFlowInvokeClient } = await import("./tracked-flow-client");
      return (client: FlowInvokeClient) =>
        trackFlowInvokeClient(client, {
          submissions,
          unsavedWorkRegistry,
          controlDraftsRef,
        });
    };
    return {
      beginSubmission,
      flowClient: createFlowInvokeClient(options, wrap),
      // The agent endpoint marks an agent's runs; the person stays the actor.
      agentClient: createFlowInvokeClient(
        { ...options, endpoint: "/api/flows/invoke/webmcp" },
        wrap,
      ),
    };
  }, [
    application,
    model.pageParameters.controls,
    runtimeInputsRef,
    controlDraftsRef,
    subject,
    unsavedWorkRegistry,
  ]);
  const applicationFrame = useApplicationFrame();
  const startPageChange = applicationFrame?.startPageChange;
  const navigation = model.navigation ?? applicationFrame?.navigation;
  const navigationEnvironment = useMemo<LinkNavigationEnvironment>(
    () => ({
      unsavedWork,
      recheckInternalTarget: async (target) => {
        if (
          target.kind === "page" &&
          model.pages.some((page) => sameId(page.pageId, target.pageId))
        )
          return true;
        // The projected page list is a rendering hint; the destination still authorises its read.
        // A page it does not offer must not resolve to the application's home address.
        showPageMessage(unavailableNotice);
        return false;
      },
      navigateInternal: (target) => {
        if (target.kind !== "page") return;
        const parameters = new URLSearchParams();
        for (const [name, value] of Object.entries(target.parameters ?? {}))
          if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
            parameters.set(name, String(value));
        const query = parameters.toString();
        const address = `${resolvePageHref(target.pageId)}${query === "" ? "" : `?${query}`}`;
        runtimeState.messages.carryToasts();
        // Inside the frame the change runs in its page transition (dimmed page, progress line).
        if (startPageChange === undefined) router.push(address);
        else startPageChange(() => router.push(address));
      },
      resolveInternalAddress: (target) =>
        target.kind === "page" ? resolvePageHref(target.pageId) : basePath,
    }),
    [
      basePath,
      model.pages,
      resolvePageHref,
      router,
      runtimeState,
      showPageMessage,
      startPageChange,
      unsavedWork,
    ],
  );
  // A dialog's form registers in its own scope: the form's placement and the dialog's run.
  const dialogStatesRef = useRef(new Map<string, FlowRuntimeState>());
  const dialogState = useCallback(
    (form: FlowFormIntent): FlowRuntimeState => {
      const scope = `dialog:${form.formId}:${form.taskId}`;
      const held = dialogStatesRef.current.get(scope);
      if (held !== undefined) return held;
      const created = scopeFlowRuntimeForms(runtimeState, scope);
      dialogStatesRef.current.set(scope, created);
      return created;
    },
    [runtimeState],
  );
  const renderForm = useCallback(
    (
      form: FlowFormIntent,
      controls: Readonly<{
        submit: (values: Extract<FlowFormAnswer, { kind: "submit" }>["values"]) => void;
        cancel: () => void;
      }>,
    ) => {
      const cancel = () => {
        formCancelledRef.current = true;
        controls.cancel();
      };
      const surface = formSurfaceComposition(
        model.page,
        model.pageId,
        form.formId,
        platformComponentRegistry,
      );
      if (surface === undefined)
        return {
          title: "Form unavailable",
          body: (
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={cancel}>
                Cancel
              </Button>
            </DialogFooter>
          ),
        };
      const placementId = surface.placementIds.find((id) => sameId(id, form.formId));
      const placement = placementId === undefined ? undefined : surface.placements[placementId];
      const block = placement?.vortex.block;
      const release =
        isRecord(block) &&
        typeof block.blockId === "string" &&
        typeof block.releaseVersion === "string"
          ? platformComponentRegistry.get(block.blockId, block.releaseVersion)?.metadata
          : undefined;
      if (placement === undefined || release === undefined)
        throw new Error(`Show form '${form.formId}' has no registered form placement`);
      const title = getAccessibleName(
        placement.settings as Parameters<typeof getAccessibleName>[0],
        release,
      );
      if (title === undefined) throw new Error(`Show form '${form.formId}' has no title`);
      const scopedInputs: Record<string, unknown> = {};
      for (const placementId of surface.placementIds) {
        const current = runtimeInputsRef.current[placementId];
        let input: Record<string, unknown> = isRecord(current) ? current : {};
        const placement = surface.placements[placementId];
        const settings =
          placement !== undefined && isRecord(placement.settings) ? placement.settings : undefined;
        const name =
          settings !== undefined &&
          isRecord(settings.name) &&
          settings.name.kind === "text" &&
          typeof settings.name.value === "string"
            ? settings.name.value
            : undefined;
        const defaultValue = name === undefined ? undefined : form.inputs[name];
        if (placement !== undefined && name !== undefined && Object.hasOwn(form.inputs, name)) {
          input = runtimeInputWithFormDefault(
            input,
            placement,
            defaultValue,
            platformComponentRegistry,
          );
        }
        const events: Record<string, unknown> = {};
        if (placementId.toLowerCase() === form.formId.toLowerCase())
          events.form_submit = (event: ControlSemanticEvent) => {
            if (event.event !== "form_submit") return;
            const values = event.readValues();
            const answer = formContinuationAnswerSchema.safeParse({
              kind: "submit",
              values,
            });
            if (!answer.success || answer.data.kind !== "submit") {
              showPageMessage(unavailableNotice);
              return;
            }
            controls.submit(answer.data.values);
          };
        else if (model.optionPlacementIds.includes(placementId))
          events.options_requested = (event: ControlSemanticEvent) => {
            if (event.event !== "options_requested") return;
            return import("./field-options").then(({ requestFieldOptions }) =>
              requestFieldOptions(model, placementId, event, () => router.refresh()),
            );
          };
        const modalInput: Record<string, unknown> = {};
        if (input.data !== undefined) modalInput.data = input.data;
        if (Object.keys(events).length > 0) modalInput.events = events;
        if (Object.keys(modalInput).length > 0) scopedInputs[placementId] = modalInput;
      }
      return {
        title,
        body: (
          <div key={form.taskId}>
            <div ref={dialogFormRef} className="flex flex-col gap-4">
              <UnsavedWorkProvider>
                <PagePuckRenderer
                  readSettings={readCompiledItemSettings}
                  composition={surface.composition}
                  registry={platformComponentRegistry}
                  fieldInputControlReleases={fieldInputControlReleases}
                  platformThemeTokens={platformThemeTokens}
                  pageId={model.pageId}
                  theme={model.theme}
                  {...(navigation === undefined ? {} : { projectedNavigation: navigation })}
                  resolvePageHref={resolvePageHref}
                  currentPageId={model.pageId}
                  runtimeInputs={scopedInputs}
                  runtimeState={dialogState(form)}
                />
              </UnsavedWorkProvider>
              <DialogFooter>
                <Button type="button" variant="secondary" onClick={cancel}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => dialogFormRef.current?.querySelector("form")?.requestSubmit()}
                >
                  Continue
                </Button>
              </DialogFooter>
            </div>
          </div>
        ),
      };
    },
    [currentData, dialogState, formCancelledRef, model, navigation, resolvePageHref, router],
  );
  const messageActionRef = useRef<(message: FlowMessageIntent) => void>(() => undefined);
  const {
    host,
    element: intentHostElement,
    banner: messageBanner,
  } = useFlowIntentHost({
    renderForm,
    navigation: navigationEnvironment,
    state: runtimeState,
    onMessageAction: (message) => messageActionRef.current(message),
    setPanel: (panel, state) => setPanelRef.current?.(panel, state),
  });
  const bindingSettings = useMemo(() => {
    const bindings = new Map<
      string,
      {
        controlId: string;
        concurrency: ComponentFlowBinding["settings"]["concurrency"];
        condition: ComponentFlowBinding["settings"]["condition"];
        debounceMs: number;
        exclusive: ComponentFlowBinding["settings"]["exclusive"];
        timeoutMs: number | null;
        event: string;
        flowName: string;
        controlName: string;
        formId?: string;
        agentConfirmation?: boolean;
      }
    >(
      Object.values(model.bindings).flatMap((items) =>
        items.map(
          (binding) =>
            [
              binding.bindingId,
              {
                controlId: binding.controlId,
                concurrency: binding.settings.concurrency,
                condition: binding.settings.condition,
                debounceMs: binding.settings.debounceMs,
                exclusive: binding.settings.exclusive,
                timeoutMs: binding.settings.timeoutMs,
                event: binding.event,
                flowName: binding.flowName,
                controlName: binding.controlName,
                ...(binding.formId === undefined ? {} : { formId: binding.formId }),
                ...(binding.agentConfirmation === true ? { agentConfirmation: true } : {}),
              },
            ] as const,
        ),
      ),
    );
    return (bindingId: string) => bindings.get(bindingId);
  }, [model.bindings]);
  const browserBindings = useMemo(() => {
    const bindings = new Map<
      string,
      NonNullable<(typeof model.bindings)[string][number]["browser"]>
    >(
      Object.values(model.bindings).flatMap((items) =>
        items.flatMap((binding) =>
          binding.browser === undefined ? [] : [[binding.bindingId, binding.browser] as const],
        ),
      ),
    );
    return (bindingId: string) => bindings.get(bindingId);
  }, [model.bindings]);
  // One flow runtime per host, shared by every event of the page: a gesture dispatches its bound
  // flow once through the one invoke client, and every pause and presentation intent is carried out
  // by the same host before the next answer is sent.
  const flowRuntime = useMemo(
    () =>
      createFlowRuntime({
        client: flowClient,
        agentClient,
        host,
        state: runtimeState,
        bindingSettings,
        begin: beginSubmission,
        browserBinding: browserBindings,
        ...(subject === undefined ? {} : { subject }),
        ...(application.flowTimeZone === undefined ? {} : { timeZone: application.flowTimeZone }),
      }),
    [
      application.flowTimeZone,
      agentClient,
      beginSubmission,
      bindingSettings,
      browserBindings,
      flowClient,
      host,
      runtimeState,
      subject,
    ],
  );
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  messageActionRef.current = (message) => {
    const all = Object.values(model.bindings).flat();
    const source = all.find((binding) => binding.bindingId === message.originBindingId);
    const authoredId = source?.messageAction?.authoredBindingId ?? source?.bindingId;
    const action = all.find(
      (binding) =>
        authoredId !== undefined &&
        binding.messageAction !== undefined &&
        binding.messageAction.authoredBindingId === authoredId &&
        binding.messageAction.sourceFlowId === message.sourceFlowId &&
        binding.messageAction.taskId === message.taskId &&
        binding.flowId === message.actionFlow,
    );
    if (action === undefined) {
      console.error("[flow] message action binding unavailable");
      showPageMessage(unavailableNotice);
      return;
    }
    const dispatched = flowRuntime.dispatch(
      action,
      message.actionInputs,
      crypto.randomUUID(),
      message.subject,
      message.sourceTablePlacementId,
    );
    applyMessageActionRef.current(dispatched, action.bindingId);
    // An action carried to the next page (Undo after a delete that opened the list) finishes after
    // this page has gone: the page now showing re-reads what the action changed.
    void dispatched.then(() => {
      if (!mountedRef.current) router.refresh();
    });
  };
  useEffect(() => {
    if (
      !Object.values(model.bindings).some((items) =>
        items.some((binding) => binding.browser !== undefined),
      )
    )
      return;
    if (Object.values(currentData).some((entry) => entry.status === "loading")) return;
    if ("requestIdleCallback" in window) {
      const handle = window.requestIdleCallback(() => {
        void flowRuntime.prefetch();
      });
      return () => window.cancelIdleCallback(handle);
    }
    const handle = globalThis.setTimeout(() => {
      void flowRuntime.prefetch();
    }, 0);
    return () => globalThis.clearTimeout(handle);
  }, [currentData, flowRuntime, model.bindings]);
  const formBlock = useMemo(() => createFormBlockRuntime(flowRuntime), [flowRuntime]);

  return { formBlock, flowRuntime, host, intentHostElement, messageBanner };
}
