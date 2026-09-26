"use client";

import { useCallback, useMemo, useState, type ReactElement } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createFullPlatformComponentRegistry,
  PageLayoutRenderer,
  type DisplaySemanticEvent,
  type ProjectedPageCapability,
} from "@vortex/ui";
import type { ApplicationPageModel, PlacementFlowBinding } from "../../../../_lib/application-page";

/** One registry shared by every rendered application page. */
const platformComponentRegistry = createFullPlatformComponentRegistry();

type DisplayEventName = DisplaySemanticEvent["event"];
type EventHandlers = Partial<Record<DisplayEventName, (event: DisplaySemanticEvent) => void>>;
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

  const runtimeInputs = useMemo(() => {
    const inputs: Record<string, unknown> = {};
    for (const [placementId, data] of Object.entries(model.data)) {
      const bindings = model.bindings[placementId] ?? [];
      const events: EventHandlers = {};
      for (const kind of ["row_clicked", "row_action", "bulk_action", "inline_edit"] as const)
        if (bindings.some((binding) => binding.event === kind))
          events[kind] = (event) => {
            const binding = bindingFor(bindings, event);
            if (binding !== undefined && !busy) void runBinding(binding, suppliedValues(event));
          };
      events.refresh = () => router.refresh();
      events.selection_changed = (event) => {
        if (event.event !== "selection_changed") return;
        setSelection((current) => {
          const held = new Set(current[placementId] ?? []);
          if (event.selected) held.add(event.recordId);
          else held.delete(event.recordId);
          return { ...current, [placementId]: [...held] };
        });
      };
      events.sort_changed = (event) => {
        if (event.event !== "sort_changed") return;
        setQuery((parameters) =>
          parameters.set(`sort.${placementId}`, `${event.columnKey}:${event.direction}`),
        );
      };
      events.filter_changed = (event) => {
        if (event.event !== "filter_changed") return;
        setQuery((parameters) => {
          const name = `filter.${placementId}.${event.field}`;
          if (event.value === "") parameters.delete(name);
          else parameters.set(name, event.value);
        });
      };
      events.search_changed = (event) => {
        if (event.event !== "search_changed") return;
        setQuery((parameters) => {
          if (event.query.trim() === "") parameters.delete(`search.${placementId}`);
          else parameters.set(`search.${placementId}`, event.query);
        });
      };
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
  }, [busy, model.bindings, model.data, router, runBinding, selection, setQuery]);

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
    </>
  );
}
