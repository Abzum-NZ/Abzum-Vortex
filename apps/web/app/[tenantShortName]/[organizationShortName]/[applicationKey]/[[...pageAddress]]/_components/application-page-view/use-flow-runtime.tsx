import {
  useCallback,
  useMemo,
  useRef,
  type Dispatch,
  type SetStateAction,
  type RefObject,
} from "react";
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
  UnsavedWorkProvider,
  useFlowIntentHost,
  type ControlSemanticEvent,
  type ChoiceInputPayload,
  type FlowFormAnswer,
  type FlowFormIntent,
  type FlowInvokeClient,
  type LinkNavigationEnvironment,
  type ServerFlowResponse,
  type PlatformThemeTokens,
} from "@vortex/ui";
import {
  formContinuationAnswerSchema,
  type ReferenceChoiceSelectionEvidenceMap,
  isRecord,
  sameId,
} from "@vortex/platform/schema";
import { Button } from "@vortex/ui/components/button";
import { DialogFooter } from "@vortex/ui/components/dialog";
import { useApplicationFrame } from "../../../_components/application-frame-state";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import type { SubmittedForm, Notice } from "./types";
import { formSurfaceComposition, runtimeInputWithFormDefault } from "./form-surface";
import { requestRecordChoices } from "./record-choices";
import { unavailableNotice } from "./notices";

export function useFlowRuntime({
  application,
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
  choicePayloadFor,
  fieldInputControlReleases,
  setNotice,
  choiceEvidenceFor,
  requestChoicePageRef,
  currentData,
  dialogFormRef,
  platformThemeTokens,
  committed,
}: Readonly<{
  application: ApplicationPageModel["invocation"];
  subject: ApplicationPageModel["subject"];
  continuingFormsRef: RefObject<Map<string, SubmittedForm>>;
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
  choicePayloadFor: (placementId: string, formId?: string) => ChoiceInputPayload | undefined;
  fieldInputControlReleases: FieldInputControlReleaseMap;
  setNotice: Dispatch<SetStateAction<Notice | undefined>>;
  choiceEvidenceFor: (
    formId: string,
    values: Readonly<Record<string, unknown>>,
    surface?: "page" | "dialog",
  ) => ReferenceChoiceSelectionEvidenceMap | undefined;
  requestChoicePageRef: RefObject<
    (
      placementId: string,
      event: Extract<ControlSemanticEvent, { event: "choices_requested" }>,
      formId?: string,
    ) => Promise<void>
  >;
  currentData: ApplicationPageModel["data"];
  dialogFormRef: RefObject<HTMLDivElement | null>;
  platformThemeTokens: PlatformThemeTokens;
  /** Re-reads what a binding writes once one of its server runs committed. */
  committed: (bindingId: string) => void;
}>) {
  /**
   * The one browser flow client and host (#1013): a form submit starts the bound flow on the server
   * and the runtime carries out every pause (another form or a confirmation) through a continuation,
   * which is returned exactly as the server issued it.
   */
  const { flowClient, webMcpClient } = useMemo(() => {
    const options = {
      address: {
        tenantShortName: application.tenantShortName,
        organizationShortName: application.organizationShortName,
        applicationKey: application.applicationKey,
        pageKey: application.pageKey,
        ...(subject === undefined ? {} : { pageRecordId: subject.recordId }),
      },
      installation: {
        installationRevision: application.installationRevision,
        releaseKey: application.releaseKey,
      },
      ...(subject === undefined ? {} : { subject }),
    };
    const recordResponse = (
      response: ServerFlowResponse,
      submission: SubmittedForm | undefined,
    ) => {
      if (submission === undefined) return;
      if (response.kind === "intent") {
        continuingFormsRef.current.set(response.continuation, submission);
      } else if (
        response.kind === "result" &&
        response.failure === undefined &&
        response.descriptor.commit === "confirmed"
      ) {
        // The server has confirmed the submitted values before its Navigate intent is presented.
        unsavedWorkRegistry?.markSaved(submission.formId, submission.values);
      }
    };
    const trackedClient = (client: FlowInvokeClient): FlowInvokeClient => ({
      startBinding: async (binding, callerInputs, clickId, signal, gestureSubject) => {
        const submission = submittedFormsRef.current.get(binding.bindingId);
        submittedFormsRef.current.delete(binding.bindingId);
        const inputs =
          submission?.choiceEvidence === undefined
            ? callerInputs
            : { ...callerInputs, choiceEvidence: submission.choiceEvidence };
        const response = await client.startBinding(
          binding,
          inputs,
          clickId,
          signal,
          gestureSubject,
        );
        recordResponse(response, submission);
        return response;
      },
      resume: async (flowId, continuation, answer, evidence, signal) => {
        if (answer.kind === "cancel") formCancelledRef.current = true;
        const submission = continuingFormsRef.current.get(continuation);
        continuingFormsRef.current.delete(continuation);
        const response = await client.resume(flowId, continuation, answer, evidence, signal);
        recordResponse(response, submission);
        return response;
      },
    });
    return {
      flowClient: trackedClient(createFlowInvokeClient(options)),
      webMcpClient: trackedClient(
        createFlowInvokeClient({ ...options, endpoint: "/api/flows/invoke/mcp" }),
      ),
    };
  }, [application, formCancelledRef, subject, unsavedWorkRegistry]);
  const startPageChange = useApplicationFrame()?.startPageChange;
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
        setNotice(unavailableNotice);
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
        // Inside the frame the change runs in its page transition (dimmed page, progress line).
        if (startPageChange === undefined) router.push(address);
        else startPageChange(() => router.push(address));
      },
      resolveInternalAddress: (target) =>
        target.kind === "page" ? resolvePageHref(target.pageId) : basePath,
    }),
    [basePath, model.pages, resolvePageHref, router, setNotice, startPageChange, unsavedWork],
  );
  const renderForm = useCallback(
    (
      form: FlowFormIntent,
      controls: Readonly<{
        submit: (
          values: Extract<FlowFormAnswer, { kind: "submit" }>["values"],
          choiceEvidence?: ReferenceChoiceSelectionEvidenceMap,
        ) => void;
        cancel: () => void;
      }>,
    ) => {
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
              <Button type="button" variant="secondary" onClick={controls.cancel}>
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
        const isReferenceChoice = model.referenceChoiceInputs.some(
          (field) =>
            field.placementId === placementId &&
            field.formId.toLowerCase() === form.formId.toLowerCase(),
        );
        const dialogChoicePage = isReferenceChoice
          ? choicePayloadFor(placementId, form.formId)
          : undefined;
        if (dialogChoicePage !== undefined)
          input = { ...input, data: { status: "ready", values: dialogChoicePage } };
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
            const answer = formContinuationAnswerSchema.safeParse({
              kind: "submit",
              values: event.values,
            });
            if (!answer.success || answer.data.kind !== "submit") {
              setNotice(unavailableNotice);
              return;
            }
            controls.submit(
              answer.data.values,
              choiceEvidenceFor(form.formId, event.values, "dialog"),
            );
          };
        else if (isReferenceChoice)
          events.choices_requested = (event: ControlSemanticEvent) => {
            if (event.event !== "choices_requested") return;
            return requestChoicePageRef.current(placementId, event, form.formId);
          };
        else if (model.linkInputPlacementIds.includes(placementId))
          events.records_requested = (event: ControlSemanticEvent) => {
            if (event.event !== "records_requested") return;
            return requestRecordChoices(model, placementId, event, () => router.refresh());
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
                  composition={surface.composition}
                  registry={platformComponentRegistry}
                  fieldInputControlReleases={fieldInputControlReleases}
                  platformThemeTokens={platformThemeTokens}
                  pageId={model.pageId}
                  theme={model.theme}
                  projectedNavigation={model.navigation}
                  resolvePageHref={resolvePageHref}
                  currentPageId={model.pageId}
                  runtimeInputs={scopedInputs}
                />
              </UnsavedWorkProvider>
              <DialogFooter>
                <Button type="button" variant="secondary" onClick={controls.cancel}>
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
    [choiceEvidenceFor, choicePayloadFor, currentData, model, resolvePageHref, router],
  );
  const { host, element: intentHostElement } = useFlowIntentHost({
    renderForm,
    navigation: navigationEnvironment,
  });
  const committedRef = useRef(committed);
  committedRef.current = committed;
  // One flow runtime per host, shared by every event of the page: a gesture dispatches its bound
  // flow once through the one invoke client, and every pause and presentation intent is carried out
  // by the same host before the next answer is sent.
  const flowRuntime = useMemo(
    () =>
      createFlowRuntime({
        client: flowClient,
        host,
        committed: (bindingId) => committedRef.current(bindingId),
      }),
    [flowClient, host],
  );
  const webMcpRuntime = useMemo(
    () =>
      createFlowRuntime({
        client: webMcpClient,
        host,
        committed: (bindingId) => committedRef.current(bindingId),
      }),
    [webMcpClient, host],
  );
  const formBlock = useMemo(() => createFormBlockRuntime(flowRuntime), [flowRuntime]);

  return { formBlock, flowRuntime, webMcpRuntime, intentHostElement };
}
