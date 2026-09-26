import "server-only";

import {
  builderKeySchema,
  componentSemanticEventKindSchema,
  conditionNodeSchema,
  containedComponentIdSchema,
  eventIdSchema,
  fieldIdSchema,
  identitySessionSchema,
  jsonValueSchema,
  organizationSelectionCandidateSchema,
  readRecordDetailContract,
  readRecordsTableContract,
  type ComponentSemanticEventKind,
  type ComponentSettingValue,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
} from "@vortex/contracts";
import type { HumanOrganizationRequestResult } from "@vortex/access";
import {
  protectedQueryCommandSchema,
  protectedQuerySortSchema,
  type ProtectedQueryCommand,
  type ProtectedQueryPage,
  type ProtectedQueryPageRow,
  type ProtectedQueryResult,
} from "@vortex/query";
import { z } from "zod";
import {
  componentContextSchema,
  createComponentContextResolver,
  type ComponentContext,
  type ComponentContextMismatchCode,
  type ComponentPlacement,
} from "./component-context-resolver";
import type { InstalledRuntimeContext } from "./installed-runtime-context";
import type { FlowOrchestrator, FlowOrchestratorResponse } from "./flow-orchestrator";

/**
 * Dispatches one component semantic event to its bound flow and its data query (issue #584).
 *
 * A data component owns one view: the page of permitted rows its bound query returns. The semantic
 * events that change that view — `load`, `refresh`, `filter_changed`, `search_changed`,
 * `sort_changed` and `page_changed` — are dataset causes: each runs the component's exact Module
 * query once, so row membership, order, totals and paging are decided by the Query engine, never by
 * a client transform of an earlier page. Every event additionally runs the flow the placement binds
 * to that control and event once, and a placement with no such binding simply has no flow to run.
 *
 * The two responsibilities this module keeps apart:
 * - A **dataset query** is the only way row membership, order or the cursor change. It resolves its
 *   typed inputs through the #583 component-context-resolver from the trusted context, so browser
 *   values can never stand in for record identity, and it calls the Query engine exactly once.
 * - A **local display filter** narrows only the page the Query engine already returned. The result
 *   then reports `rowsScope: "local_page"` and `locallyFiltered: true`, keeps the engine's own page
 *   size and next cursor, and never presents the narrowed rows as a filtered dataset.
 *
 * Every failure is a closed refusal with a stable code: a request that does not parse, an installed
 * context for another organisation or Application than the selection, a context or binding the
 * resolver rejects, an event with no placement to query, a query the viewer may not run,
 * and a filter supplied for an event that returns no page. The module never throws to its caller and
 * never runs a half-resolved flow or query.
 */

/** The `ComponentSemanticEventKind`s that cause a new dataset page (issue #584). */
export const componentDatasetViewEvents = [
  "load",
  "refresh",
  "filter_changed",
  "search_changed",
  "sort_changed",
  "page_changed",
] as const;

const datasetViewEventSet: ReadonlySet<ComponentSemanticEventKind> = new Set(
  componentDatasetViewEvents,
);

/** Codes this dispatcher adds to the #583 resolver's own mismatch codes. */
export const componentEventDispatchRefusalCodes = [
  "invalid_request",
  "invalid_context",
  "unsupported_event",
  "missing_placement",
  "component_data_contract_invalid",
  "input_values_invalid",
  "query_refused",
  "query_unavailable",
  "local_filter_invalid",
  "local_filter_without_page",
] as const;
export type ComponentEventDispatchRefusalCode =
  | ComponentContextMismatchCode
  | (typeof componentEventDispatchRefusalCodes)[number];

/**
 * One display-only filter over the page the Query engine already returned. It is never sent to the
 * Query engine and never changes the cursor, page size or row membership of the dataset: it only
 * selects which of the returned rows the surface shows.
 */
export const componentLocalDisplayFilterConditionSchema = z
  .object({
    fieldId: fieldIdSchema,
    operator: z.enum(["equals", "not_equals", "contains", "empty", "not_empty"]),
    value: z.string().max(200).optional(),
  })
  .strict()
  .refine(
    (condition) =>
      (condition.operator === "empty" || condition.operator === "not_empty") ===
      (condition.value === undefined),
    { message: "A comparison names a value; an emptiness check names none" },
  );
export type ComponentLocalDisplayFilterCondition = z.infer<
  typeof componentLocalDisplayFilterConditionSchema
>;

export const componentLocalDisplayFilterSchema = z
  .object({
    /** ANDed conditions; the returned page is narrowed only where all of them hold. */
    conditions: z.array(componentLocalDisplayFilterConditionSchema).min(1).max(20),
  })
  .strict();
export type ComponentLocalDisplayFilter = z.infer<typeof componentLocalDisplayFilterSchema>;

/**
 * The viewer's dataset view for one view event, in the Query engine's own vocabulary. A filter is
 * the typed condition tree the engine parses; an empty sort uses the query's declared sort. The
 * page size is never the viewer's: it is the placement's declared page size. The continuation token
 * is the engine's own opaque, authenticated cursor from an earlier page, passed back unchanged.
 */
const componentEventViewSchema = z
  .object({
    sort: z.array(protectedQuerySortSchema).max(20).default([]),
    filter: conditionNodeSchema.optional(),
    search: z.string().min(1).max(200).optional(),
    continuationToken: z.string().min(1).max(65_536).optional(),
  })
  .strict();
export type ComponentEventView = z.infer<typeof componentEventViewSchema>;

/**
 * One component event to dispatch. The control, event, trusted context and caller values come from
 * the surface; the dataset view is the viewer's current sort, filter, search and page. The module
 * adds nothing from the browser that the resolver or Query engine would treat as authority.
 */
export const componentEventDispatchRequestSchema = z
  .object({
    controlId: containedComponentIdSchema,
    eventId: eventIdSchema,
    event: componentSemanticEventKindSchema,
    context: componentContextSchema,
    /** The caller inputs the surface fills, by the name the binding declares. */
    suppliedValues: z
      .record(builderKeySchema, z.unknown())
      .refine((values) => Object.keys(values).length <= 100, {
        message: "A surface supplies at most one value per bound input",
      })
      .default({}),
    /** Values the page supplies for the placement's declared page parameters. */
    pageParameters: z.record(builderKeySchema, z.unknown()).default({}),
    view: componentEventViewSchema.default({ sort: [] }),
    localFilter: componentLocalDisplayFilterSchema.optional(),
  })
  .strict();
export type ComponentEventDispatchRequest = z.input<typeof componentEventDispatchRequestSchema>;

/** One returned row with the authoritative identity, revision and capabilities the engine decided. */
export type ComponentEventDataRow = Readonly<{
  recordId: ProtectedQueryPageRow["recordId"];
  revision: ProtectedQueryPageRow["revision"];
  capabilities: ProtectedQueryPageRow["capabilities"];
  /** Declared row fields the viewer may read, keyed by the declared field identity. */
  fields: Readonly<Record<string, JsonValue>>;
  /** Declared fields the engine withheld for this viewer; absent rather than blanked. */
  withheldFieldIds: readonly string[];
}>;

/**
 * The page a view event returns. `datasetPageSize` and `nextContinuationToken` are the Query
 * engine's own page facts, preserved even when a local display filter narrowed the rows shown, so a
 * caller can always tell a filtered view of one page from a filtered dataset.
 */
export type ComponentEventDataResult = Readonly<{
  moduleRootId: string;
  queryId: string;
  moduleReleaseVersion: string;
  rows: readonly ComponentEventDataRow[];
  nextContinuationToken?: string;
  /** How many rows the engine returned for this page, before any local display filter. */
  datasetPageSize: number;
  /** `local_page` only when a display filter narrowed the returned page; otherwise `dataset_page`. */
  rowsScope: "dataset_page" | "local_page";
  /** Whether the displayed rows are a display-only subset of the returned page. */
  locallyFiltered: boolean;
}>;

/** Why a dataset event ran its query but returned no page; never an empty page. */
export type ComponentEventDataRefusal = Readonly<{
  code: "query_refused" | "query_unavailable";
  /** The Query engine's own neutral reason code, when it refused the request. */
  reason?: string;
}>;

export type ComponentEventDispatchResult =
  | Readonly<{ kind: "refused"; code: ComponentEventDispatchRefusalCode; field?: string }>
  | Readonly<{
      kind: "completed";
      event: ComponentSemanticEventKind;
      /** The bound flow's own response, or absent when the placement binds no flow to the event. */
      flow?: FlowOrchestratorResponse;
      /** The dataset page the event returned, or absent for an event that reads no page. */
      data?: ComponentEventDataResult;
      /** Set only when a dataset event ran its query but the viewer's page was not permitted. */
      dataRefusal?: ComponentEventDataRefusal;
    }>;

export type ComponentEventDispatchDependencies = Readonly<{
  /**
   * Runs the exact protected Module query once (#572). The composition supplies the protected query
   * service's own `run`, which authorises the viewer's current authority and owns its transaction.
   */
  runQuery: (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: ProtectedQueryCommand,
  ) => Promise<HumanOrganizationRequestResult<ProtectedQueryResult>>;
  /** Starts the flow the component event is bound to (#579). */
  flow: Pick<FlowOrchestrator, "start">;
  /**
   * The flow release key of the exact installed release this context was assembled from, in the
   * same form the orchestrator's release resolver issues (the composition owns that form). Every
   * flow start is pinned to it, so a flow resolved against this release never runs against another.
   */
  flowReleaseKeyOf: (installed: InstalledRuntimeContext) => string;
}>;

type DeclaredDataContract = Readonly<{
  kind: "table" | "record_detail";
  /** Declared row fields, in declaration order; the only fields a row may carry. */
  fieldIds: readonly string[];
  pageSize: number;
  sortableFieldIds: readonly string[];
  filterableFieldIds: readonly string[];
  search: boolean;
}>;

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const lowerUnique = (values: readonly string[]): string[] => [
  ...new Set(values.map((value) => value.toLowerCase())),
];

/**
 * Reads the placement's declared data contract from its compiled settings: a Records table's
 * declared columns, page size, sortable and filterable fields, or a Record detail's declared
 * fields. The Query engine still enforces its own bounds; this only says which fields the row may
 * carry and which the viewer's user choices may name.
 */
const readDeclaredDataContract = (
  settings: Readonly<Record<string, ComponentSettingValue>>,
): DeclaredDataContract | undefined => {
  const table = readRecordsTableContract(settings);
  if (table !== undefined) {
    const fieldIds = [...new Set(table.columns.map((column) => column.field))];
    if (fieldIds.length === 0) return undefined;
    return {
      kind: "table",
      fieldIds,
      pageSize: table.pageSize,
      sortableFieldIds: lowerUnique(table.sortableFields),
      filterableFieldIds: lowerUnique(table.filterableFields),
      search: table.search,
    };
  }
  const detail = readRecordDetailContract(settings);
  if (detail !== undefined) {
    const fieldIds = [...new Set(detail.fields.map((field) => field.field))];
    if (fieldIds.length === 0) return undefined;
    return {
      kind: "record_detail",
      fieldIds,
      pageSize: 1,
      sortableFieldIds: [],
      filterableFieldIds: [],
      search: false,
    };
  }
  return undefined;
};

/**
 * Builds the exact #572 command for one view event. The Module query, typed inputs and page
 * parameters come from the #583 resolution; the requested fields, page size and allow-lists come
 * only from the trusted installed release's declared contract, and the viewer's sort, filter and
 * search are passed through so the engine can intersect them with its own bounds. Returns undefined
 * when the command is not one the engine accepts, so the event is refused before any read.
 */
const buildQueryCommand = (
  resolved: Readonly<{ moduleRootId: string; queryId: string }>,
  inputValues: Readonly<Record<string, JsonValue>>,
  contract: DeclaredDataContract,
  view: ComponentEventView,
): ProtectedQueryCommand | undefined => {
  const parsed = protectedQueryCommandSchema.safeParse({
    moduleRootId: resolved.moduleRootId,
    queryId: resolved.queryId,
    inputValues,
    requestedFieldIds: contract.fieldIds,
    requestedSystemFieldKeys: [],
    sort: contract.kind === "table" ? view.sort : [],
    ...(contract.kind === "table" && view.filter !== undefined ? { filter: view.filter } : {}),
    ...(contract.kind === "table" && contract.search && view.search !== undefined
      ? { search: view.search }
      : {}),
    sortableFieldIds: contract.sortableFieldIds,
    filterableFieldIds: contract.filterableFieldIds,
    // The table contract declares only a search box, not a searchable field list; an empty declared
    // set tells the engine to search every field the record type marks searchable.
    searchableFieldIds: [],
    pageSize: contract.pageSize,
    ...(view.continuationToken === undefined
      ? {}
      : { continuationToken: view.continuationToken }),
  });
  return parsed.success ? parsed.data : undefined;
};

/** The row's stored value for a declared field, matched without regard to case. */
const rowValueOf = (
  row: ProtectedQueryPageRow,
  fieldId: string,
): JsonValue | undefined => {
  const entry = Object.entries(row.values).find(([candidate]) => sameId(candidate, fieldId));
  return entry === undefined ? undefined : entry[1];
};

/** The display text of one field for a local filter: strings, numbers and booleans, else undefined. */
const localFilterText = (value: JsonValue | undefined): string | undefined => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
};

/** Whether one returned row satisfies one display-only filter condition. */
const matchesLocalCondition = (
  row: ComponentEventDataRow,
  condition: ComponentLocalDisplayFilterCondition,
): boolean => {
  const text = localFilterText(
    Object.entries(row.fields).find(([fieldId]) => sameId(fieldId, condition.fieldId))?.[1],
  );
  switch (condition.operator) {
    case "equals":
      return text !== undefined && text === condition.value;
    case "not_equals":
      return text !== condition.value;
    case "contains":
      return text !== undefined && condition.value !== undefined && text.includes(condition.value);
    case "empty":
      return text === undefined || text === "";
    case "not_empty":
      return text !== undefined && text !== "";
  }
};

/**
 * Maps one Query engine page into the component result: each row keeps the engine's record identity,
 * revision and per-row capabilities, and carries only the declared fields the viewer may read; a
 * withheld declared field is absent and named. A local display filter narrows the rows shown but
 * leaves the engine's page size and cursor untouched, so the result never claims to filter the
 * dataset.
 */
const projectPage = (
  page: ProtectedQueryPage,
  contract: DeclaredDataContract,
  localFilter: ComponentLocalDisplayFilter | undefined,
): ComponentEventDataResult => {
  const rows = page.rows.map((row): ComponentEventDataRow => {
    const fields: Record<string, JsonValue> = {};
    const withheldFieldIds: string[] = [];
    for (const fieldId of contract.fieldIds) {
      const value = rowValueOf(row, fieldId);
      if (value === undefined) withheldFieldIds.push(fieldId);
      else fields[fieldId] = value;
    }
    return {
      recordId: row.recordId,
      revision: row.revision,
      capabilities: row.capabilities,
      fields,
      withheldFieldIds,
    };
  });
  const locallyFiltered = localFilter !== undefined;
  const displayed =
    localFilter === undefined
      ? rows
      : rows.filter((row) =>
          localFilter.conditions.every((condition) => matchesLocalCondition(row, condition)),
        );
  return {
    moduleRootId: page.moduleRootId,
    queryId: page.queryId,
    moduleReleaseVersion: page.moduleReleaseVersion,
    rows: displayed,
    ...(page.nextContinuationToken === undefined
      ? {}
      : { nextContinuationToken: page.nextContinuationToken }),
    datasetPageSize: page.rows.length,
    rowsScope: locallyFiltered ? "local_page" : "dataset_page",
    locallyFiltered,
  };
};

const refused = (
  code: ComponentEventDispatchRefusalCode,
  field?: string,
): ComponentEventDispatchResult =>
  field === undefined ? { kind: "refused", code } : { kind: "refused", code, field };

/** Whether a component context is one a dataset view event declares: never a row or selection. */
const datasetViewContext = (context: ComponentContext): boolean =>
  context.kind === "page_subject" || context.kind === "related_record" || context.kind === "no_record";

/**
 * Binds one already-verified installed context, so a page dispatches many component events without
 * passing the trusted context each time. `placement` is the event's data placement, taken by the
 * composition from the installed release and never from the browser; it is absent for an event
 * whose component reads no page.
 */
export const createComponentEventDispatcher = (dependencies: ComponentEventDispatchDependencies) =>
  Object.freeze({
    async dispatch(
      installed: InstalledRuntimeContext,
      sessionCandidate: IdentitySession,
      selectionCandidate: OrganizationSelectionCandidate,
      requestCandidate: ComponentEventDispatchRequest,
      placement?: ComponentPlacement,
    ): Promise<ComponentEventDispatchResult> {
      const request = componentEventDispatchRequestSchema.safeParse(requestCandidate);
      const session = identitySessionSchema.safeParse(sessionCandidate);
      const selection = organizationSelectionCandidateSchema.safeParse(selectionCandidate);
      if (!request.success || !session.success || !selection.success)
        return refused("invalid_request");

      let resolver: ReturnType<typeof createComponentContextResolver>;
      let releaseKey: string;
      try {
        resolver = createComponentContextResolver(installed);
        releaseKey = dependencies.flowReleaseKeyOf(installed);
      } catch {
        return refused("invalid_context");
      }
      // The flow and the query run under the selected organisation and Application; both must be
      // the ones this installed context was assembled for, or the event would resolve against one
      // release and run against another.
      if (
        !sameId(selection.data.organizationId, installed.organizationId) ||
        selection.data.applicationRootId === undefined ||
        !sameId(selection.data.applicationRootId, installed.applicationRootId) ||
        releaseKey.length === 0
      )
        return refused("invalid_context");

      const { controlId, eventId, event, context, suppliedValues, pageParameters, view, localFilter } =
        request.data;

      // Resolve the event's bound flow first. A binding this event cannot fill is refused; no
      // binding at all leaves the event with no flow, which is normal for a data placement.
      const flowResolution = resolver.resolveFlowInputs({
        controlId,
        eventId,
        context,
        suppliedValues,
      });
      if (flowResolution.kind === "mismatch" && flowResolution.code !== "unknown_binding")
        return refused(flowResolution.code, flowResolution.field);

      const isDatasetView = datasetViewEventSet.has(event);
      // An event with neither a dataset cause nor a bound flow has nothing to dispatch.
      if (!isDatasetView && flowResolution.kind !== "resolved") return refused("unsupported_event");
      // A display filter needs a returned page to narrow; one supplied for an event that reads no
      // page is refused before anything runs rather than silently ignored.
      if (!isDatasetView && localFilter !== undefined) return refused("local_filter_without_page");

      // Every check below completes before the flow or the query runs, so a wrong context, field,
      // value or filter refuses the whole event instead of reaching either half-filled.
      let contract: DeclaredDataContract | undefined;
      let command: ProtectedQueryCommand | undefined;
      if (isDatasetView) {
        // A dataset view reads the page subject, a related record or no record. The resolver checks
        // this only for a bound flow, so it is checked here for the query as well.
        if (!datasetViewContext(context)) return refused("unexpected_event_context");
        if (placement === undefined) return refused("missing_placement");
        contract = readDeclaredDataContract(placement.settings);
        if (contract === undefined) return refused("component_data_contract_invalid");
        const declaredFieldIds = contract.fieldIds;
        // A display filter may only read the placement's declared row fields.
        if (
          localFilter !== undefined &&
          !localFilter.conditions.every((condition) =>
            declaredFieldIds.some((fieldId) => sameId(fieldId, condition.fieldId)),
          )
        )
          return refused("local_filter_invalid");

        const queryResolution = resolver.resolveQueryInputs(placement, context, pageParameters);
        if (queryResolution.kind === "mismatch")
          return refused(queryResolution.code, queryResolution.field);
        const inputValues = z
          .record(builderKeySchema, jsonValueSchema)
          .safeParse(queryResolution.inputValues);
        if (!inputValues.success) return refused("input_values_invalid");
        command = buildQueryCommand(queryResolution, inputValues.data, contract, view);
        if (command === undefined) return refused("component_data_contract_invalid");
      }

      // The event's own flow runs exactly once, for the verified initiator and selected
      // organisation, pinned to the exact installed release its inputs were resolved against.
      let flow: FlowOrchestratorResponse | undefined;
      if (flowResolution.kind === "resolved")
        flow = await dependencies.flow.start(
          {
            session: session.data,
            selection: selection.data,
            binding: { flowId: flowResolution.flowId, inputs: flowResolution.inputs },
          },
          { releaseKey },
        );

      // The event's exact Module query runs exactly once, under the viewer's current authority. A
      // query that fails is reported, never retried.
      let data: ComponentEventDataResult | undefined;
      let dataRefusal: ComponentEventDataRefusal | undefined;
      if (command !== undefined && contract !== undefined) {
        let run: HumanOrganizationRequestResult<ProtectedQueryResult> | undefined;
        try {
          run = await dependencies.runQuery(session.data, selection.data, command);
        } catch {
          run = undefined;
        }
        if (run === undefined || run.kind !== "available") {
          dataRefusal = { code: "query_unavailable" };
        } else {
          const page = run.value;
          if (page.outcome === "refused")
            dataRefusal = { code: "query_refused", reason: page.reasonCode };
          else data = projectPage(page, contract, localFilter);
        }
      }

      return {
        kind: "completed",
        event,
        ...(flow === undefined ? {} : { flow }),
        ...(data === undefined ? {} : { data }),
        ...(dataRefusal === undefined ? {} : { dataRefusal }),
      };
    },
  });

export type ComponentEventDispatcher = ReturnType<typeof createComponentEventDispatcher>;
