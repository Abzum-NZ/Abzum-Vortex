"use client";

import { useCallback, useMemo, useState, type ReactElement } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createFlowInvokeClient,
  createFlowRuntime,
  createFormBlockRuntime,
  createFullPlatformComponentRegistry,
  PageLayoutRenderer,
  useFlowIntentHost,
  type ControlSemanticEvent,
  type DisplaySemanticEvent,
  type FlowDispatchResult,
  type FlowFormAnswer,
  type FlowFormIntent,
  type FormBlockRuntime,
  type LinkNavigationEnvironment,
  type ProjectedPageCapability,
} from "@vortex/ui";
import type { ApplicationPageModel, PlacementFlowBinding } from "../../../../_lib/application-page";

/**
 * The full component flow binding the browser runtime expects. A {@link PlacementFlowBinding} carries
 * only the identities the page needs; a form submit reaches the server by binding id and flow id, so
 * its input map is not required here.
 */
type ComponentFlowBinding = Parameters<FormBlockRuntime["submit"]>[0];

const asFormBinding = (
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

/**
 * The fixed sentence for each safe flow outcome. The endpoint returns only the outcome, never a
 * server message, so what a person reads is the same whatever the flow did.
 */
const outcomeNotices: Readonly<Record<string, Notice>> = {
  completed: { tone: "info", text: "Done." },
  committed: { tone: "info", text: "Saved." },
  refused: { tone: "problem", text: "You do not have permission to do that." },
  conflict: { tone: "problem", text: "This changed since you opened it. Refresh and review it." },
  validation: { tone: "problem", text: "Check the values and try again." },
  partial: { tone: "problem", text: "Only part of this was saved. Refresh and review what changed." },
  uncertain: { tone: "problem", text: "The result is not certain yet. Refresh before trying again." },
  background_pending: { tone: "info", text: "Started. It will finish in the background." },
  failed: { tone: "problem", text: "That did not work. Try again." },
};

const unavailableNotice: Notice = { tone: "problem", text: "That is not available right now." };

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
 */
const suppliedValues = (event: DisplaySemanticEvent): Record<string, unknown> => {
  switch (event.event) {
    case "row_clicked":
    case "row_action":
      return { record_id: event.recordId };
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

const eventIdOf = (event: DisplaySemanticEvent): string | undefined =>
  "eventId" in event ? event.eventId : undefined;

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
 * the page was rendered from; the page then refreshes so the affected view shows the persisted
 * result. Nothing here decides permission or runs an operation itself.
 */
export function ApplicationPageView({
  model,
}: Readonly<{ model: ApplicationPageModel }>): ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [selection, setSelection] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const application = model.invocation;
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

  /**
   * The one browser flow client and host (#1013): a form submit starts the bound flow on the server
   * and the runtime carries out every pause (another form or a confirmation) through a continuation,
   * which is returned exactly as the server issued it.
   */
  const flowClient = useMemo(
    () =>
      createFlowInvokeClient({
        address: {
          tenantShortName: application.tenantShortName,
          organizationShortName: application.organizationShortName,
          applicationKey: application.applicationKey,
        },
        installation: {
          installationRevision: application.installationRevision,
          releaseKey: application.releaseKey,
        },
      }),
    [application],
  );
  const navigationEnvironment = useMemo<LinkNavigationEnvironment>(
    () => ({
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
    [basePath, resolvePageHref, router],
  );
  const renderForm = useCallback(
    (
      form: FlowFormIntent,
      controls: Readonly<{
        submit: (values: FlowFormAnswer["values"]) => void;
        cancel: () => void;
      }>,
    ) => (
      <form
        className="vortex-form"
        onSubmit={(event) => {
          event.preventDefault();
          const entered = new FormData(event.currentTarget);
          const values: Record<string, string> = {};
          for (const [name, value] of entered.entries()) values[name] = String(value);
          controls.submit(values);
        }}
      >
        {Object.entries(form.inputs).map(([name, value]) => (
          <label key={name} className="vortex-field">
            <span>{name}</span>
            <input
              name={name}
              defaultValue={
                typeof value === "string" || typeof value === "number" ? String(value) : ""
              }
            />
          </label>
        ))}
        <div className="vortex-dialog-actions">
          <button
            type="button"
            className="vortex-button vortex-button-secondary"
            onClick={controls.cancel}
          >
            Cancel
          </button>
          <button type="submit" className="vortex-button vortex-button-primary">
            Continue
          </button>
        </div>
      </form>
    ),
    [],
  );
  const { host, element: intentHostElement } = useFlowIntentHost({
    renderForm,
    navigation: navigationEnvironment,
  });
  // One form-block runtime per host: a gesture dispatches its bound flow once and every pause is
  // carried out by the same host before the next answer is sent.
  const formBlock = useMemo(
    () => createFormBlockRuntime(createFlowRuntime({ client: flowClient, host })),
    [flowClient, host],
  );

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

  const carryOutIntents = useCallback(
    (intents: readonly Readonly<{ kind: string; properties: Readonly<Record<string, unknown>> }>[]) => {
      for (const intent of intents) {
        if (intent.kind === "navigate" && typeof intent.properties.page === "string") {
          const parameters = new URLSearchParams();
          const supplied = intent.properties.parameters;
          if (typeof supplied === "object" && supplied !== null)
            for (const [name, value] of Object.entries(supplied))
              if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
                parameters.set(name, String(value));
          const query = parameters.toString();
          router.push(`${resolvePageHref(intent.properties.page)}${query === "" ? "" : `?${query}`}`);
          return;
        }
        if (intent.kind === "show_message" && typeof intent.properties.message === "string")
          setNotice({ tone: "info", text: intent.properties.message });
      }
    },
    [resolvePageHref, router],
  );

  const runBinding = useCallback(
    async (binding: PlacementFlowBinding, supplied: Record<string, unknown>) => {
      const callerInputs = Object.fromEntries(
        Object.entries(supplied).filter(([name]) => binding.callerInputs.includes(name)),
      );
      setBusy(true);
      setNotice(undefined);
      try {
        const response = await fetch("/api/flows/invoke", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            tenantShortName: application.tenantShortName,
            organizationShortName: application.organizationShortName,
            applicationKey: application.applicationKey,
            invocation: {
              kind: "binding",
              installationRevision: application.installationRevision,
              releaseKey: application.releaseKey,
              bindingId: binding.bindingId,
              flowId: binding.flowId,
              clickId: crypto.randomUUID(),
              callerInputs,
            },
          }),
        });
        const result: Record<string, unknown> | undefined = await response
          .json()
          .then((body: unknown) => (typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined))
          .catch(() => undefined);
        // A page rendered from an older installation reloads instead of running a stale binding.
        if (result?.kind === "reload" || result?.kind === "result")
          // A selection made before the run may name records the run changed or removed.
          setSelection({});
        if (result?.kind === "reload") return router.refresh();
        if (result?.kind === "result") {
          const descriptor = result.descriptor as { outcome?: string } | undefined;
          setNotice(outcomeNotices[descriptor?.outcome ?? "failed"] ?? unavailableNotice);
          if (Array.isArray(result.intents)) carryOutIntents(result.intents);
          // The affected view re-reads its persisted data whatever the flow reported.
          return router.refresh();
        }
        if (result?.kind === "intent") {
          setNotice({ tone: "problem", text: "This action needs a step that is not available here yet." });
          return;
        }
        setNotice(unavailableNotice);
      } catch {
        setNotice(unavailableNotice);
      } finally {
        setBusy(false);
      }
    },
    [application, carryOutIntents, router],
  );

  /**
   * Reports a server-driven flow's safe outcome for a form gesture. The runtime already carried out
   * every pause through a continuation; only the final outcome is shown, and the page re-reads the
   * persisted data whatever the flow reported.
   */
  const applyDispatch = useCallback(
    async (dispatch: Promise<FlowDispatchResult | undefined>) => {
      setBusy(true);
      setNotice(undefined);
      try {
        const result = await dispatch;
        if (result === undefined) return;
        if (result.ranIn === "browser") {
          setNotice(unavailableNotice);
          return;
        }
        const server = result.result;
        if (server.kind === "reload") {
          setSelection({});
          return router.refresh();
        }
        if (server.kind === "finished") {
          setSelection({});
          setNotice(outcomeNotices[server.descriptor.outcome] ?? unavailableNotice);
          return router.refresh();
        }
        if (server.kind === "refused") {
          setNotice(outcomeNotices.refused ?? unavailableNotice);
          return;
        }
        setNotice(unavailableNotice);
      } catch {
        setNotice(unavailableNotice);
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  const runtimeInputs = useMemo(() => {
    const inputs: Record<string, unknown> = {};
    // A placement may hold bindings (a form submits) without holding projected data, so both key
    // sets are wired: every placement with data or with a flow binding receives its callbacks.
    const placementIds = new Set([...Object.keys(model.data), ...Object.keys(model.bindings)]);
    for (const placementId of placementIds) {
      const data = model.data[placementId];
      const bindings = model.bindings[placementId] ?? [];
      const events: EventHandlers = {};
      for (const kind of ["row_clicked", "row_action", "bulk_action", "inline_edit"] as const)
        if (bindings.some((binding) => binding.event === kind))
          events[kind] = (event: DisplaySemanticEvent) => {
            const binding = bindingFor(bindings, event);
            if (binding !== undefined && !busy) void runBinding(binding, suppliedValues(event));
          };
      events.refresh = () => router.refresh();
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
      // A form container emits its one submission for a gesture; it runs the bound flow once
      // through the runtime, which resumes every pause with the server-issued continuation.
      const submitBinding = bindings.find((binding) => binding.event === "form_submit");
      if (submitBinding !== undefined)
        events.form_submit = (event: ControlSemanticEvent) => {
          if (event.event !== "form_submit" || busy) return;
          void applyDispatch(
            formBlock.submit(asFormBinding(placementId, submitBinding), { values: event.values }),
          );
        };
      const readyBinding = bindings.find((binding) => binding.event === "form_ready");
      if (readyBinding !== undefined)
        events.form_ready = (event: ControlSemanticEvent) => {
          if (event.event !== "form_ready" || busy) return;
          void applyDispatch(formBlock.ready(asFormBinding(placementId, readyBinding)));
        };
      const resetBinding = bindings.find((binding) => binding.event === "form_reset");
      if (resetBinding !== undefined)
        events.form_reset = (event: ControlSemanticEvent) => {
          if (event.event !== "form_reset" || busy) return;
          void applyDispatch(formBlock.reset(asFormBinding(placementId, resetBinding)));
        };
      if (data === undefined) {
        inputs[placementId] = { events };
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
      };
    }
    return inputs;
  }, [applyDispatch, busy, formBlock, model.bindings, model.data, router, runBinding, selection, setQuery]);

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
    </>
  );
}
