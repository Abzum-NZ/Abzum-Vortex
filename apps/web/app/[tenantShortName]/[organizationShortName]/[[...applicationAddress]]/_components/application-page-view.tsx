"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createFlowInvokeClient,
  createFlowRuntime,
  createFormBlockRuntime,
  createFullPlatformComponentRegistry,
  equalFormValue,
  FORM_CONTAINER_BLOCK_RELEASE,
  PageLayoutRenderer,
  UnsavedWorkProvider,
  useFlowIntentHost,
  useUnsavedWorkGuard,
  useUnsavedWorkRegistry,
  type ControlSemanticEvent,
  type DisplaySemanticEvent,
  type FlowDispatchResult,
  type FlowFormAnswer,
  type FlowFormIntent,
  type FlowInvokeClient,
  type FormBlockRuntime,
  type LinkNavigationEnvironment,
  type ProjectedPageCapability,
  type ServerFlowResponse,
} from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vortex/ui/components/dialog";
import { Field, FieldGroup } from "@vortex/ui/components/field";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import type {
  ApplicationPageModel,
  PageDataState,
  PlacementFlowBinding,
} from "../../../../_lib/application-page";
import {
  isCurrentComponentRequestGeneration,
  nextComponentRequestGeneration,
  type ComponentRequestGeneration,
} from "@vortex/app/component-result-state";
import { containedComponentIdSchema } from "@vortex/contracts";
import { rereadApplicationPlacements } from "../placement-refresh-action";

type EditFormBaseline = ApplicationPageModel["editFormBaselines"][string];

/**
 * The full component flow binding the browser runtime expects. A {@link PlacementFlowBinding} carries
 * only the identities the page needs; every event reaches the server by binding id and flow id, and
 * the server fills the flow's inputs from the installed binding, so its input map is not required here.
 */
type ComponentFlowBinding = Parameters<FormBlockRuntime["submit"]>[0];

const asComponentBinding = (
  placementId: string,
  binding: PlacementFlowBinding,
): ComponentFlowBinding =>
  ({
    bindingId: binding.bindingId,
    // The placement id and the binding's control id are the same stable identity.
    controlId: placementId,
    eventId: binding.eventId,
    event: binding.event,
    flow: { flowId: binding.flowId, inputs: {} },
  }) as ComponentFlowBinding;

/** One registry shared by every rendered application page. */
const platformComponentRegistry = createFullPlatformComponentRegistry();

/**
 * A placement's event callbacks. Display events and control events (the form's ready, reset and
 * submit) are both delivered through the one runtime-inputs map, so the key is the event name.
 */
type EventHandlers = Record<string, (event: never) => void>;
type Notice = Readonly<{ tone: "info" | "problem"; text: string }>;
type FormNotice = Readonly<{ tone: "success" | "problem"; text: string }>;
type SubmittedForm = Readonly<{
  formId: string;
  values: Readonly<Record<string, unknown>>;
}>;

/**
 * The fixed sentence for each safe flow outcome. The endpoint returns only the outcome, never a
 * server message, so what a person reads is the same whatever the flow did.
 */
const outcomeNotices: Readonly<Record<string, Notice>> = {
  completed: { tone: "info", text: "Done." },
  committed: { tone: "info", text: "Saved." },
  refused: {
    tone: "problem",
    text: "The operation was refused by current access rules or operation policy. Review your access and the submitted values.",
  },
  conflict: { tone: "problem", text: "This changed since you opened it. Refresh and review it." },
  validation: {
    tone: "problem",
    text: "One or more submitted values do not match the operation's required format or rules. Review each field and its allowed values.",
  },
  partial: {
    tone: "problem",
    text: "Only part of this was saved. Refresh and review what changed.",
  },
  uncertain: {
    tone: "problem",
    text: "The result is not certain yet. Refresh before trying again.",
  },
  background_pending: { tone: "info", text: "Started. It will finish in the background." },
  failed: { tone: "problem", text: "That did not work. Try again." },
};

const unavailableNotice: Notice = { tone: "problem", text: "That is not available right now." };

/**
 * A run that reached a task the platform cannot run yet. It is not a refusal, so the person is
 * never told they lack a permission for it.
 */
const notAvailableNotice: Notice = { tone: "problem", text: "This is not available yet." };

/** The notice for a finished run: its safe outcome, unless a task was not available. */
const finishedNotice = (outcome: string | undefined, failureCode: unknown): Notice =>
  failureCode === "task_not_available"
    ? notAvailableNotice
    : (outcomeNotices[outcome ?? "failed"] ?? unavailableNotice);

/** The JSON a table cell reports when a surface hands it to a flow as a caller input. */
const cellToJson = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return null;
  const cell = value as Record<string, unknown>;
  switch (cell.kind) {
    case "text":
      return cell.text;
    case "number":
    case "boolean":
      return cell.value;
    case "date":
      return cell.iso;
    case "choice":
      return cell.key;
    case "link":
      return cell.address;
    default:
      return null;
  }
};

/**
 * What a component event supplies to its bound flow, by the caller input names the flow declares.
 * The vocabulary is closed and event-shaped: `record_id`, `record_ids`, `revision`, `field` and
 * `value`. A binding receives only the names it declares, and the endpoint refuses anything else.
 *
 * A row action carries the row's server-projected current revision exactly as an inline-edit commit
 * does, so a command that changes one existing row is bound at the revision the person actually saw.
 * The value comes from the projected row, never from anything the person types.
 */
const suppliedValues = (event: DisplaySemanticEvent): Record<string, unknown> => {
  switch (event.event) {
    case "row_clicked":
      return { record_id: event.recordId };
    case "row_action":
      return {
        record_id: event.recordId,
        ...(event.revision === undefined ? {} : { revision: event.revision }),
      };
    case "bulk_action":
      return { record_ids: [...event.recordIds] };
    case "inline_edit":
      return {
        record_id: event.recordId,
        field: event.field,
        value: cellToJson(event.value),
        ...(event.revision === undefined ? {} : { revision: event.revision }),
      };
    default:
      return {};
  }
};

/**
 * The one binding a control placement holds for an event its control emits without an event
 * identity. A placement that holds several for the same event names none, so nothing is guessed.
 */
const bindingOfEvent = (
  bindings: readonly PlacementFlowBinding[],
  event: string,
): PlacementFlowBinding | undefined => {
  const ofKind = bindings.filter((binding) => binding.event === event);
  return ofKind.length === 1 ? ofKind[0] : undefined;
};

const eventIdOf = (event: DisplaySemanticEvent): string | undefined =>
  "eventId" in event ? event.eventId : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Finds the form ancestor that owns each placement in the rendered page tree. */
const formOwnersByPlacement = (
  page: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> => {
  const owners: Record<string, string> = {};
  const visit = (slot: unknown, formOwner?: string): void => {
    if (!isRecord(slot) || !isRecord(slot.placements)) return;
    for (const [placementId, candidate] of Object.entries(slot.placements)) {
      if (!isRecord(candidate)) continue;
      const block = candidate.block;
      const owner =
        isRecord(block) &&
        typeof block.blockId === "string" &&
        block.blockId.toLowerCase() === FORM_CONTAINER_BLOCK_RELEASE.blockId.toLowerCase()
          ? placementId
          : formOwner;
      if (owner !== undefined) owners[placementId] = owner;
      if (isRecord(candidate.slots))
        for (const child of Object.values(candidate.slots)) visit(child, owner);
    }
  };
  const composition = page.composition;
  if (!isRecord(composition)) return owners;
  if ("main" in composition) visit(composition.main);
  else if (isRecord(composition.stepContent))
    for (const child of Object.values(composition.stepContent)) visit(child);
  return owners;
};

/**
 * Finds the binding an event identity names. A legacy row action that names no control matches only
 * when the placement declares exactly one row-action binding, so it never guesses between several.
 */
const bindingFor = (
  bindings: readonly PlacementFlowBinding[],
  event: DisplaySemanticEvent,
): PlacementFlowBinding | undefined => {
  const ofKind = bindings.filter((binding) => binding.event === event.event);
  const eventId = eventIdOf(event);
  if (eventId !== undefined) return ofKind.find((binding) => binding.eventId === eventId);
  return ofKind.length === 1 ? ofKind[0] : undefined;
};

/**
 * Renders one installed application page and carries out what its people do on it. Every
 * declared component event goes to the one flow endpoint with the exact installation and binding
 * the page was rendered from; after a write, only data placements affected by that source are
 * re-read. Nothing here decides permission or runs an operation itself.
 */
export function ApplicationPageView({
  model,
}: Readonly<{ model: ApplicationPageModel }>): ReactElement {
  return (
    <UnsavedWorkProvider>
      <ApplicationPageViewContent model={model} />
    </UnsavedWorkProvider>
  );
}

function ApplicationPageViewContent({
  model,
}: Readonly<{ model: ApplicationPageModel }>): ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentSearch = searchParams.toString();
  const [selection, setSelection] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [refreshedPlacementData, setRefreshedPlacementData] = useState<
    | Readonly<{
        navigationKey: string;
        data: Readonly<Record<string, PageDataState>>;
        editFormBaselines: Readonly<Record<string, EditFormBaseline | null>>;
      }>
    | undefined
  >(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [formFeedback, setFormFeedback] = useState<Readonly<Record<string, FormNotice>>>({});
  const [busy, setBusy] = useState(false);
  const [leavePromptOpen, setLeavePromptOpen] = useState(false);
  const unsavedWorkRegistry = useUnsavedWorkRegistry();
  const submittedFormsRef = useRef(new Map<string, SubmittedForm>());
  const continuingFormsRef = useRef(new Map<string, SubmittedForm>());
  const confirmationResolveRef = useRef<((leave: boolean) => void) | undefined>(undefined);
  const confirmationPromiseRef = useRef<Promise<boolean> | undefined>(undefined);
  const confirmDiscardUnsavedWork = useCallback((): Promise<boolean> => {
    if (confirmationPromiseRef.current !== undefined) return Promise.resolve(false);
    const confirmation = new Promise<boolean>((resolve) => {
      confirmationResolveRef.current = resolve;
    });
    confirmationPromiseRef.current = confirmation;
    setLeavePromptOpen(true);
    return confirmation;
  }, []);
  const settleDiscardConfirmation = useCallback(
    (leave: boolean) => {
      const resolve = confirmationResolveRef.current;
      if (resolve === undefined) return;
      confirmationResolveRef.current = undefined;
      confirmationPromiseRef.current = undefined;
      setLeavePromptOpen(false);
      if (leave) unsavedWorkRegistry?.clearAll();
      resolve(leave);
    },
    [unsavedWorkRegistry],
  );
  useEffect(
    () => () => {
      const resolve = confirmationResolveRef.current;
      confirmationResolveRef.current = undefined;
      confirmationPromiseRef.current = undefined;
      resolve?.(false);
    },
    [],
  );
  const { hasUnsavedWork, guard: unsavedWork } = useUnsavedWorkGuard(confirmDiscardUnsavedWork);

  const application = model.invocation;
  const subject = model.subject;
  const formOwners = useMemo(() => formOwnersByPlacement(model.page), [model.page]);
  const serverDataRef = useRef(model.data);
  const serverDataGenerationRef = useRef(0);
  if (serverDataRef.current !== model.data) {
    serverDataRef.current = model.data;
    serverDataGenerationRef.current += 1;
  }
  const navigationBase = JSON.stringify([
    pathname,
    currentSearch,
    model.pageId,
    application.installationRevision,
    application.releaseKey,
    serverDataGenerationRef.current,
  ]);
  const navigationSequenceRef = useRef(0);
  const placementRequestsRef = useRef<{
    base: string;
    key: string;
    generations: Map<string, ComponentRequestGeneration>;
  }>({ base: "", key: "", generations: new Map<string, ComponentRequestGeneration>() });
  if (placementRequestsRef.current.base !== navigationBase) {
    navigationSequenceRef.current += 1;
    placementRequestsRef.current = {
      base: navigationBase,
      key: `${navigationBase}:${navigationSequenceRef.current}`,
      generations: new Map(),
    };
  }
  const navigationKey = placementRequestsRef.current.key;
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
  const refreshPlacements = useCallback(
    async (placementIds: readonly string[]): Promise<void> => {
      const pageKey = currentPageKey;
      const requestScope = placementRequestsRef.current;
      if (pageKey === undefined) return;

      const requests = new Map<string, ComponentRequestGeneration>();
      for (const placementId of new Set(placementIds)) {
        const parsedId = containedComponentIdSchema.safeParse(placementId);
        if (!parsedId.success) continue;
        const key = parsedId.data.toLowerCase();
        const request = nextComponentRequestGeneration(
          requestScope.generations.get(key),
          parsedId.data,
          requestScope.key,
        );
        requestScope.generations.set(key, request);
        requests.set(key, request);
      }
      if (requests.size === 0) return;

      const loadedData = new Map<string, PageDataState>();
      const loadedBaselines = new Map<string, EditFormBaseline | null>();
      const requestEntries = [...requests.entries()];
      for (let offset = 0; offset < requestEntries.length; offset += 500) {
        if (placementRequestsRef.current.key !== requestScope.key) return;
        const batch = requestEntries
          .slice(offset, offset + 500)
          .filter(([key, request]) =>
            isCurrentComponentRequestGeneration(requestScope.generations.get(key), request),
          );
        if (batch.length === 0) continue;

        let result: Awaited<ReturnType<typeof rereadApplicationPlacements>>;
        try {
          result = await rereadApplicationPlacements(
            {
              tenantShortName: application.tenantShortName,
              organizationShortName: application.organizationShortName,
              applicationKey: application.applicationKey,
              pageKey,
              search: currentSearch,
            },
            batch.map(([, request]) => request.componentId),
          );
        } catch {
          continue;
        }
        if (placementRequestsRef.current.key !== requestScope.key) return;

        for (const [key, request] of batch) {
          if (
            !isCurrentComponentRequestGeneration(requestScope.generations.get(key), request)
          )
            continue;
          const data =
            result.kind === "available"
              ? Object.entries(result.data).find(([candidate]) => candidate.toLowerCase() === key)?.[1]
              : undefined;
          const baseline =
            result.kind === "available"
              ? Object.entries(result.editFormBaselines).find(
                  ([candidate]) => candidate.toLowerCase() === key,
                )?.[1] ?? null
              : null;
          loadedData.set(key, data ?? { status: "error" });
          loadedBaselines.set(key, baseline);
        }
      }

      const accepted: {
        key: string;
        request: ComponentRequestGeneration;
        placementId: string;
        data: PageDataState;
        editFormBaseline: EditFormBaseline | null;
      }[] = [];
      for (const [key, request] of requests) {
        if (
          !loadedData.has(key) ||
          !isCurrentComponentRequestGeneration(requestScope.generations.get(key), request)
        )
          continue;
        const displayKey =
          Object.keys(model.data).find((candidate) => candidate.toLowerCase() === key) ??
          request.componentId;
        accepted.push({
          key,
          request,
          placementId: displayKey,
          data: loadedData.get(key) ?? { status: "error" },
          editFormBaseline: loadedBaselines.get(key) ?? null,
        });
      }
      if (accepted.length === 0) return;
      setRefreshedPlacementData((current) => {
        const liveScope = placementRequestsRef.current;
        if (liveScope?.key !== requestScope.key) return current;
        const data = { ...(current?.navigationKey === requestScope.key ? current.data : {}) };
        const editFormBaselines = {
          ...(current?.navigationKey === requestScope.key ? current.editFormBaselines : {}),
        };
        let changed = false;
        for (const entry of accepted) {
          if (!isCurrentComponentRequestGeneration(liveScope.generations.get(entry.key), entry.request))
            continue;
          data[entry.placementId] = entry.data;
          editFormBaselines[entry.placementId] = entry.editFormBaseline;
          changed = true;
        }
        return changed
          ? { navigationKey: requestScope.key, data, editFormBaselines }
          : current;
      });
    },
    [application, currentPageKey, currentSearch, model.data],
  );
  const refreshTargetsForSource = useCallback(
    (sourcePlacementId: string): readonly string[] => {
      const match = Object.entries(model.refreshPlacementsBySource).find(
        ([candidate]) => candidate.toLowerCase() === sourcePlacementId.toLowerCase(),
      );
      return match?.[1] ?? [];
    },
    [model.refreshPlacementsBySource],
  );
  const currentData = useMemo(
    () =>
      refreshedPlacementData?.navigationKey === navigationKey
        ? { ...model.data, ...refreshedPlacementData.data }
        : model.data,
    [model.data, navigationKey, refreshedPlacementData],
  );
  const currentEditFormBaselines = useMemo(() => {
    const baselines = { ...model.editFormBaselines };
    if (refreshedPlacementData?.navigationKey === navigationKey)
      for (const [placementId, baseline] of Object.entries(
        refreshedPlacementData.editFormBaselines,
      )) {
        if (baseline === null) delete baselines[placementId];
        else baselines[placementId] = baseline;
      }
    return baselines;
  }, [model.editFormBaselines, navigationKey, refreshedPlacementData]);

  useEffect(() => {
    if (!hasUnsavedWork) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!unsavedWork.hasUnsavedWork()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsavedWork, unsavedWork]);

  useEffect(() => {
    if (!hasUnsavedWork) return;
    const onDocumentClick = (event: MouseEvent): void => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const target =
        event.target instanceof Element
          ? event.target
          : event.target instanceof Node
            ? event.target.parentElement
            : null;
      const anchor = target?.closest<HTMLAnchorElement>("a[href]");
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        (anchor.target !== "" && anchor.target.toLowerCase() !== "_self") ||
        anchor.hasAttribute("download")
      )
        return;
      let address: URL;
      try {
        address = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (!["http:", "https:"].includes(address.protocol) || !unsavedWork.hasUnsavedWork()) return;
      if (
        address.origin === window.location.origin &&
        address.pathname === window.location.pathname &&
        address.search === window.location.search
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        if (!(await unsavedWork.confirmDiscardUnsavedWork())) return;
        if (address.origin === window.location.origin)
          router.push(`${address.pathname}${address.search}${address.hash}`);
        else window.location.assign(address.href);
      })();
    };
    document.addEventListener("click", onDocumentClick, true);
    return () => document.removeEventListener("click", onDocumentClick, true);
  }, [hasUnsavedWork, router, unsavedWork]);

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
      startBinding: async (binding, callerInputs, clickId) => {
        const submission = submittedFormsRef.current.get(binding.bindingId);
        submittedFormsRef.current.delete(binding.bindingId);
        const response = await client.startBinding(binding, callerInputs, clickId);
        recordResponse(response, submission);
        return response;
      },
      resume: async (flowId, continuation, answer, evidence) => {
        const submission = continuingFormsRef.current.get(continuation);
        continuingFormsRef.current.delete(continuation);
        const response = await client.resume(flowId, continuation, answer, evidence);
        recordResponse(response, submission);
        return response;
      },
    };
  }, [application, subject, unsavedWorkRegistry]);
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
  const formFieldId = useId();
  // The body of a Show form surface. The flow intent host presents it inside its shadcn Dialog, so
  // the body is built from the same shadcn field, input and button parts and ends in the dialog's footer.
  const renderForm = useCallback(
    (
      form: FlowFormIntent,
      controls: Readonly<{
        submit: (values: Extract<FlowFormAnswer, { kind: "submit" }>["values"]) => void;
        cancel: () => void;
      }>,
    ) => (
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const entered = new FormData(event.currentTarget);
          const values: Record<string, string> = {};
          for (const [name, value] of entered.entries()) values[name] = String(value);
          controls.submit(values);
        }}
      >
        <FieldGroup>
          {Object.entries(form.inputs).map(([name, value], index) => (
            <Field key={name}>
              <Label htmlFor={`${formFieldId}-${index}`}>{name}</Label>
              <Input
                id={`${formFieldId}-${index}`}
                name={name}
                defaultValue={
                  typeof value === "string" || typeof value === "number" ? String(value) : ""
                }
              />
            </Field>
          ))}
        </FieldGroup>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={controls.cancel}>
            Cancel
          </Button>
          <Button type="submit">Continue</Button>
        </DialogFooter>
      </form>
    ),
    [formFieldId],
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
  const formBlock = useMemo(() => createFormBlockRuntime(flowRuntime), [flowRuntime]);

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

  /**
   * Reports a server-driven flow's safe outcome for any gesture. The runtime already carried out
   * every pause through a continuation and every presentation intent through the host; only the
   * final outcome is shown, and affected placements re-read their persisted data after a write. A
   * gesture the form block ignored because the same binding is already running leaves the page as
   * that run set it.
   */
  const applyDispatch = useCallback(
    async (
      dispatch: Promise<FlowDispatchResult | undefined>,
      formPlacementId?: string,
      afterAccepted?: () => Promise<Notice | undefined>,
      sourcePlacementId?: string,
    ) => {
      setBusy(true);
      setNotice(undefined);
      if (formPlacementId !== undefined)
        setFormFeedback((current) => {
          if (!Object.hasOwn(current, formPlacementId)) return current;
          const next = { ...current };
          delete next[formPlacementId];
          return next;
        });
      const showResult = (resultNotice: Notice): void => {
        setNotice(resultNotice);
        if (formPlacementId !== undefined)
          setFormFeedback((current) => ({
            ...current,
            [formPlacementId]: {
              tone: resultNotice.tone === "problem" ? "problem" : "success",
              text: resultNotice.text,
            },
          }));
      };
      let settles = true;
      try {
        const result = await dispatch;
        if (result === undefined) {
          settles = false;
          return;
        }
        if (result.ranIn === "browser") {
          showResult(unavailableNotice);
          return;
        }
        const server = result.result;
        if (server.kind === "reload") {
          return router.refresh();
        }
        if (server.kind === "finished") {
          let resultNotice = finishedNotice(server.descriptor.outcome, server.failure?.code);
          if (
            afterAccepted !== undefined &&
            ["completed", "committed", "background_pending"].includes(
              server.descriptor.outcome,
            )
          ) {
            try {
              resultNotice = (await afterAccepted()) ?? resultNotice;
            } catch {
              resultNotice = unavailableNotice;
            }
          }
          showResult(resultNotice);
          const refreshSource = sourcePlacementId ?? formPlacementId;
          if (
            (server.descriptor.commit === "confirmed" || server.descriptor.commit === "partial") &&
            refreshSource !== undefined
          )
            void refreshPlacements(refreshTargetsForSource(refreshSource));
          return;
        }
        if (server.kind === "refused") {
          showResult(unavailableNotice);
          return;
        }
        if (server.kind === "abandoned") {
          // The run may have committed a step before the answer was lost: never report nothing.
          showResult(outcomeNotices.uncertain ?? unavailableNotice);
          const refreshSource = sourcePlacementId ?? formPlacementId;
          if (refreshSource !== undefined)
            void refreshPlacements(refreshTargetsForSource(refreshSource));
          return;
        }
        showResult(unavailableNotice);
      } catch {
        showResult(unavailableNotice);
      } finally {
        if (settles) setBusy(false);
      }
    },
    [refreshPlacements, refreshTargetsForSource, router],
  );

  /**
   * Runs the flow bound to a display or action event through the same runtime as a form gesture.
   * The binding receives only the caller inputs it declares; the server fills the rest from the
   * installed binding and refuses anything else.
   */
  const runBinding = useCallback(
    (placementId: string, binding: PlacementFlowBinding, supplied: Record<string, unknown>) =>
      applyDispatch(
        flowRuntime.dispatch(
          asComponentBinding(placementId, binding),
          Object.fromEntries(
            Object.entries(supplied).filter(([name]) => binding.callerInputs.includes(name)),
          ),
        ),
        formOwners[placementId],
        undefined,
        placementId,
      ),
    [applyDispatch, formOwners, flowRuntime],
  );

  const runtimeInputs = useMemo(() => {
    const inputs: Record<string, unknown> = {};
    // A placement may hold bindings (a form submits) without holding projected data, so both key
    // sets are wired: every placement with data or with a flow binding receives its callbacks.
    const placementIds = new Set([
      ...Object.keys(currentData),
      ...Object.keys(model.bindings),
      ...Object.keys(formFeedback),
    ]);
    for (const placementId of placementIds) {
      const data = currentData[placementId];
      const bindings = model.bindings[placementId] ?? [];
      const events: EventHandlers = {};
      const flowFeedback =
        formOwners[placementId] === placementId ? formFeedback[placementId] : undefined;
      // Display callbacks belong only to a placement with projected data; a control placement's
      // own parser refuses an event name it does not declare, so they are never added to a form.
      if (data !== undefined) {
        for (const kind of ["row_clicked", "row_action", "bulk_action", "inline_edit"] as const)
          if (bindings.some((binding) => binding.event === kind))
            events[kind] = (event: DisplaySemanticEvent) => {
              const binding = bindingFor(bindings, event);
              if (binding !== undefined && !busy)
                void runBinding(placementId, binding, suppliedValues(event));
            };
        events.refresh = () => {
          void refreshPlacements([placementId]);
        };
        events.selection_changed = (event: DisplaySemanticEvent) => {
          if (event.event !== "selection_changed") return;
          setSelection((current) => {
            const held = new Set(current[placementId] ?? []);
            if (event.selected) held.add(event.recordId);
            else held.delete(event.recordId);
            return { ...current, [placementId]: [...held] };
          });
        };
        events.sort_changed = (event: DisplaySemanticEvent) => {
          if (event.event !== "sort_changed") return;
          setQuery((parameters) =>
            parameters.set(`sort.${placementId}`, `${event.columnKey}:${event.direction}`),
          );
        };
        events.filter_changed = (event: DisplaySemanticEvent) => {
          if (event.event !== "filter_changed") return;
          setQuery((parameters) => {
            const name = `filter.${placementId}.${event.field}`;
            if (event.value === "") parameters.delete(name);
            else parameters.set(name, event.value);
          });
        };
        events.search_changed = (event: DisplaySemanticEvent) => {
          if (event.event !== "search_changed") return;
          setQuery((parameters) => {
            if (event.query.trim() === "") parameters.delete(`search.${placementId}`);
            else parameters.set(`search.${placementId}`, event.query);
          });
        };
      }
      // An action button runs its bound flow through the same path as a display event. Inside a
      // form it reports the form's current values. A record page also supplies its verified page
      // subject for declared navigation bindings; the binding receives only the inputs it declares.
      const actionBinding = bindingOfEvent(bindings, "action");
      if (actionBinding !== undefined)
        events.action = (event: ControlSemanticEvent) => {
          if (event.event !== "action" || event.intent !== "activate" || busy) return;
          return runBinding(placementId, actionBinding, {
            ...(event.values ?? {}),
            ...(subject === undefined ? {} : { record_id: subject.recordId }),
          });
        };
      // A form container emits its one submission for a gesture; it runs the bound flow once
      // through the runtime, which resumes every pause with the server-issued continuation.
      const submitBinding = bindings.find((binding) => binding.event === "form_submit");
      if (submitBinding !== undefined)
        events.form_submit = (event: ControlSemanticEvent) => {
          if (event.event !== "form_submit" || busy) return;
          const baseline = currentEditFormBaselines[placementId];
          const values =
            baseline === undefined
              ? event.values
              : Object.fromEntries(
                  Object.entries(event.values).filter(
                    ([name, value]) =>
                      Object.hasOwn(baseline, name) && !equalFormValue(value, baseline[name]),
                  ),
                );
          if (baseline !== undefined && Object.keys(values).length === 0) {
            setNotice({ tone: "info", text: "No changes to save." });
            setFormFeedback((current) => ({
              ...current,
              [placementId]: { tone: "success", text: "No changes to save." },
            }));
            return;
          }
          submittedFormsRef.current.set(submitBinding.bindingId, {
            formId: placementId,
            values: event.values,
          });
          void applyDispatch(
            formBlock.submit(asComponentBinding(placementId, submitBinding), values),
            placementId,
            undefined,
            placementId,
          );
        };
      const readyBinding = bindings.find((binding) => binding.event === "form_ready");
      if (readyBinding !== undefined)
        events.form_ready = (event: ControlSemanticEvent) => {
          if (event.event !== "form_ready" || busy) return;
          void applyDispatch(
            formBlock.ready(asComponentBinding(placementId, readyBinding)),
            undefined,
            undefined,
            placementId,
          );
        };
      const resetBinding = bindings.find((binding) => binding.event === "form_reset");
      if (resetBinding !== undefined)
        events.form_reset = (event: ControlSemanticEvent) => {
          if (event.event !== "form_reset" || busy) return;
          setFormFeedback((current) => {
            if (!Object.hasOwn(current, placementId)) return current;
            const next = { ...current };
            delete next[placementId];
            return next;
          });
          void applyDispatch(
            formBlock.reset(asComponentBinding(placementId, resetBinding)),
            undefined,
            undefined,
            placementId,
          );
        };
      if (data === undefined) {
        if (Object.keys(events).length > 0 || flowFeedback !== undefined)
          inputs[placementId] = {
            ...(Object.keys(events).length === 0 ? {} : { events }),
            ...(flowFeedback === undefined ? {} : { flowFeedback }),
          };
        continue;
      }
      const held = selection[placementId];
      const ready = data as { status?: string; values?: Record<string, unknown> };
      inputs[placementId] = {
        data:
          ready.status === "ready" && ready.values?.kind === "table" && held !== undefined
            ? { ...ready, values: { ...ready.values, selectedRecordIds: held } }
            : data,
        events,
        ...(flowFeedback === undefined ? {} : { flowFeedback }),
      };
    }
    return inputs;
  }, [
    applyDispatch,
    busy,
    formBlock,
    formFeedback,
    formOwners,
    currentData,
    currentEditFormBaselines,
    model.bindings,
    model.data,
    router,
    refreshPlacements,
    runBinding,
    selection,
    setQuery,
    subject,
  ]);

  return (
    <>
      {notice === undefined ? null : (
        <p role={notice.tone === "problem" ? "alert" : "status"} data-vortex-notice={notice.tone}>
          {notice.text}
        </p>
      )}
      <PageLayoutRenderer
        composition={model.page as unknown as ProjectedPageCapability}
        registry={platformComponentRegistry}
        shells={model.shells}
        pageId={model.pageId}
        theme={model.theme}
        projectedNavigation={model.navigation}
        resolvePageHref={resolvePageHref}
        currentPageId={model.pageId}
        runtimeInputs={runtimeInputs}
      />
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
