import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactElement,
  type ReactNode,
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
  type FieldInputControlReleaseMap,
  type createFullPlatformComponentRegistry,
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
  type ReferenceChoiceSelectionEvidence,
  isRecord,
} from "@vortex/platform/schema";
import { Button } from "@vortex/ui/components/button";
import { DialogFooter } from "@vortex/ui/components/dialog";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import type { SubmittedForm, Notice } from "./types";
import { formSurfaceComposition, runtimeInputWithFormDefault } from "./form-surface";
import { choiceScopeKey } from "./event-values";
import { unavailableNotice } from "./notices";

/** The keyed Show Form body owns its choice request lifetime, including Escape dismissal. */
function ChoiceFormLifetime({
  children,
  mount,
  unmount,
  context,
  baseline,
}: Readonly<{
  children: ReactNode;
  mount: () => void;
  unmount: () => void;
  context: unknown;
  baseline: unknown;
}>): ReactElement {
  const callbacks = useRef({ mount, unmount });
  callbacks.current = { mount, unmount };
  useEffect(() => {
    const current = callbacks.current;
    current.mount();
    return current.unmount;
  }, [context, baseline]);
  return <>{children}</>;
}

export function useFlowRuntime({
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
}: Readonly<{
  application: ApplicationPageModel["invocation"];
  subject: ApplicationPageModel["subject"];
  continuingFormsRef: RefObject<Map<string, SubmittedForm>>;
  unsavedWorkRegistry: ReturnType<typeof useUnsavedWorkRegistry>;
  submittedFormsRef: RefObject<Map<string, SubmittedForm>>;
  router: ReturnType<typeof useRouter>;
  resolvePageHref: (pageId: string) => string;
  basePath: string;
  unsavedWork: ReturnType<typeof useUnsavedWorkGuard>["guard"];
  model: ApplicationPageModel;
  platformComponentRegistry: ReturnType<typeof createFullPlatformComponentRegistry>;
  runtimeInputsRef: RefObject<Readonly<Record<string, unknown>>>;
  choicePayloadFor: (placementId: string, formId?: string) => ChoiceInputPayload | undefined;
  choiceDefaultContextsRef: RefObject<Record<string, boolean>>;
  fieldInputControlReleases: FieldInputControlReleaseMap;
  choiceSelectionsRef: RefObject<
    Record<string, Readonly<{ key: string; evidence: ReferenceChoiceSelectionEvidence }>>
  >;
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
  changeChoiceField: (
    placementId: string,
    event: ControlSemanticEvent,
    dialogFormId?: string,
  ) => void;
  initializeChoiceForm: (
    formId: string,
    dialogFormId?: string,
    defaults?: Readonly<Record<string, unknown>>,
  ) => void;
  currentData: ApplicationPageModel["data"];
  clearChoiceForm: (formId: string, dialogFormId?: string) => void;
  dialogFormRef: RefObject<HTMLDivElement | null>;
  platformThemeTokens: PlatformThemeTokens;
}>) {
  /**
   * The one browser flow client and host (#1013): a form submit starts the bound flow on the server
   * and the runtime carries out every pause (another form or a confirmation) through a continuation,
   * which is returned exactly as the server issued it.
   */
  const flowClient = useMemo<FlowInvokeClient>(() => {
    const client = createFlowInvokeClient({
      address: {
        tenantShortName: application.tenantShortName,
        organizationShortName: application.organizationShortName,
        applicationKey: application.applicationKey,
        pageKey: application.pageKey,
      },
      installation: {
        installationRevision: application.installationRevision,
        releaseKey: application.releaseKey,
      },
      ...(subject === undefined ? {} : { subject }),
    });
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
    return {
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
        const submission = continuingFormsRef.current.get(continuation);
        continuingFormsRef.current.delete(continuation);
        const response = await client.resume(flowId, continuation, answer, evidence, signal);
        recordResponse(response, submission);
        return response;
      },
    };
  }, [application, subject, unsavedWorkRegistry]);
  const webMcpClient = useMemo(
    () =>
      createFlowInvokeClient({
        address: {
          tenantShortName: application.tenantShortName,
          organizationShortName: application.organizationShortName,
          applicationKey: application.applicationKey,
          pageKey: application.pageKey,
        },
        installation: {
          installationRevision: application.installationRevision,
          releaseKey: application.releaseKey,
        },
        ...(subject === undefined ? {} : { subject }),
        endpoint: "/api/flows/invoke/mcp",
      }),
    [application, subject],
  );
  const navigationEnvironment = useMemo<LinkNavigationEnvironment>(
    () => ({
      unsavedWork,
      recheckInternalTarget: async (target) => target.kind !== "external",
      navigateInternal: (target) => {
        if (target.kind !== "page") return;
        const parameters = new URLSearchParams();
        for (const [name, value] of Object.entries(target.parameters ?? {}))
          if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
            parameters.set(name, String(value));
        const query = parameters.toString();
        router.push(`${resolvePageHref(target.pageId)}${query === "" ? "" : `?${query}`}`);
      },
      resolveInternalAddress: (target) =>
        target.kind === "page" ? resolvePageHref(target.pageId) : basePath,
    }),
    [basePath, resolvePageHref, router, unsavedWork],
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
        return (
          <div className="flex flex-col gap-4">
            <p role="alert">Form unavailable.</p>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={controls.cancel}>
                Cancel
              </Button>
            </DialogFooter>
          </div>
        );
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
        const choiceField = model.referenceChoiceInputs.find(
          (field) => field.placementId === placementId,
        );
        const defaultValue = name === undefined ? undefined : form.inputs[name];
        const defaultEvidence =
          typeof defaultValue === "string"
            ? dialogChoicePage?.optionEvidence?.[defaultValue]
            : undefined;
        const dependentDefaultOffered =
          choiceField?.dependency === undefined ||
          (choiceDefaultContextsRef.current[choiceScopeKey(placementId, form.formId)] === true &&
            defaultEvidence !== undefined &&
            dialogChoicePage?.options?.some((option) => option.key === defaultValue) === true);
        if (
          placement !== undefined &&
          name !== undefined &&
          Object.hasOwn(form.inputs, name) &&
          dependentDefaultOffered
        ) {
          input = runtimeInputWithFormDefault(
            input,
            placement,
            form.inputs[name],
            platformComponentRegistry,
            fieldInputControlReleases,
          );
          if (
            choiceField?.dependency !== undefined &&
            typeof defaultValue === "string" &&
            defaultEvidence !== undefined
          ) {
            choiceSelectionsRef.current[choiceScopeKey(placementId, form.formId)] = {
              key: defaultValue,
              evidence: defaultEvidence,
            };
          }
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
        if (isReferenceChoice)
          events.field_changed = (event: ControlSemanticEvent) =>
            changeChoiceField(placementId, event, form.formId);
        if (placementId.toLowerCase() === form.formId.toLowerCase())
          events.form_reset = (event: ControlSemanticEvent) => {
            if (event.event === "form_reset")
              initializeChoiceForm(form.formId, form.formId, form.inputs);
          };
        const modalInput: Record<string, unknown> = {};
        if (input.data !== undefined) modalInput.data = input.data;
        if (Object.keys(events).length > 0) modalInput.events = events;
        if (Object.keys(modalInput).length > 0) scopedInputs[placementId] = modalInput;
      }
      return (
        <ChoiceFormLifetime
          key={form.taskId}
          context={model}
          baseline={currentData}
          mount={() => initializeChoiceForm(form.formId, form.formId, form.inputs)}
          unmount={() => clearChoiceForm(form.formId, form.formId)}
        >
          <div ref={dialogFormRef} className="flex flex-col gap-4">
            <UnsavedWorkProvider>
              <PagePuckRenderer
                themeMode="system"
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
        </ChoiceFormLifetime>
      );
    },
    [
      choiceEvidenceFor,
      choicePayloadFor,
      changeChoiceField,
      clearChoiceForm,
      currentData,
      initializeChoiceForm,
      model,
      resolvePageHref,
    ],
  );
  const { host, element: intentHostElement } = useFlowIntentHost({
    renderForm,
    navigation: navigationEnvironment,
  });
  // One flow runtime per host, shared by every event of the page: a gesture dispatches its bound
  // flow once through the one invoke client, and every pause and presentation intent is carried out
  // by the same host before the next answer is sent.
  const flowRuntime = useMemo(
    () => createFlowRuntime({ client: flowClient, host }),
    [flowClient, host],
  );
  const webMcpRuntime = useMemo(
    () => createFlowRuntime({ client: webMcpClient, host }),
    [webMcpClient, host],
  );
  const formBlock = useMemo(() => createFormBlockRuntime(flowRuntime), [flowRuntime]);

  return { formBlock, flowRuntime, webMcpRuntime, intentHostElement };
}
