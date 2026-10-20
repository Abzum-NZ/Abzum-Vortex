import "server-only";

import { randomUUID } from "node:crypto";
import {
  authoredGridLayout,
  isRecord,
  sameId,
  type GridLayout,
  type IdentitySession,
  type JsonValue,
  type RecordsTableExportRefusal,
  type RecordsTableExportRequest,
  type RecordsTableFilterValue,
  type RecordsTableSortKey,
} from "../../schema";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
} from "../../access/index";
import {
  createProtectedQueryService,
  prepareRecordsExport,
  recordsCsvFormat,
  type QueryContinuationKey,
  type RecordsExportCell,
  type RecordsExportFormat,
  type RecordsExportOutcome,
  type RecordsExportPage,
} from "../../queries/index";
import type { ProtectedQueryRow } from "../../queries/protected-query-contracts";
import { recordLinkLabelKey } from "../../definition/app-index";
import {
  addressedDefaultGridViews,
  gridLayoutVisibleFieldIds,
  gridViewLayout,
  resolveGridLayout,
  resolveSelectedGridView,
} from "../grid-view-state";
import { addressedGridView, readGridViews } from "../grid-views";
import {
  collectRecordLinkValues,
  type ProjectedRecordLink,
  type RecordLinkResolver,
} from "../component-data-projection";
import {
  fieldChoiceLabelsOf,
  fieldDateTypesOf,
  fieldFilterTargetsOf,
  fieldLabelsOf,
  fieldLinkTypesOf,
  type PlacementField,
} from "../placement-read/shared";
import { buildRecordsTableQueryCommand } from "../records-table-query";
import { openRecordsSelection, type RecordsSelectionDescriptor } from "../records-selection-seal";
import { createRecordsTableBulkService } from "./bulk-run";
import {
  loadRecordsTablePlacement,
  type RecordsTableCommandAddress,
  type RecordsTablePlacement,
} from "./placement";
import { decideRecordTypeExport, decideRecordTypeFieldIds } from "./record-type-access";
import type { InstalledRuntimeContext } from "../../definition/index";

/**
 * The one authority behind a Records table export. It re-reads the installed placement and
 * decides everything under the person's current access: the table's Export feature, the standard
 * export permission of the record type, the sealed descriptor of the read the rows came from, the
 * columns (the person's own layout or the saved view they showed, narrowed to the fields they may
 * read and export) and the rows (the protected query, in keyset pages of at most 200). The browser
 * names a selection and a view; it never names a field, a query or a permission. Each page is read
 * and its export permission checked again before it is written, and one batched read resolves the
 * permitted titles of the page's links. The bytes go through the shared export transport, which
 * keeps one page and its stream buffers in memory. Every attempt and outcome is an Activity entry
 * that names the record type and columns, never a value; counts go to the server log.
 */

export type RecordsTableExportDependencies = HumanOrganizationRequestDependencies &
  Readonly<{ continuationKey: QueryContinuationKey }>;

/** The most rows a read of a selection of shown rows yields at once, so the first bytes come soon. */
const selectedRowsPageSize = 25;

/** A failure the transport reports as the export's reason; the person only sees a neutral message. */
const exportFailure = (reason: string, cause?: unknown): Error =>
  Object.assign(new Error("The export is incomplete. Please try again.", { cause }), {
    part: "export",
    reason,
  });

const failureReason = (cause: unknown): string =>
  cause instanceof Error &&
  "part" in cause &&
  cause.part === "export" &&
  "reason" in cause &&
  typeof cause.reason === "string"
    ? cause.reason
    : "preparation_failed";

type ExportColumn = Readonly<{ fieldId: string; label: string; field: PlacementField }>;

/** The value type a column's cells carry: a calculation's or total's result type, else its own. */
const valueTypeOf = (field: PlacementField): string =>
  field.type === "calculation" || field.type === "total" ? field.settings.resultType : field.type;

const exportableTypes: ReadonlySet<string> = new Set([
  "text",
  "long_text",
  "reference_number",
  "email_address",
  "phone_number",
  "web_address",
  "choice",
  "several_choices",
  "whole_number",
  "decimal_number",
  "money",
  "yes_no",
  "date",
  "date_time",
  "link",
  "link_to_one_of_several",
]);

/**
 * One stored value as an export cell. A value the field's type does not allow stops the export
 * rather than being written as something else.
 */
const cellOf = (
  column: ExportColumn,
  value: JsonValue | undefined,
  choiceLabels: ReadonlyMap<string, string>,
  titles: ReadonlyMap<string, ProjectedRecordLink>,
): RecordsExportCell => {
  // A withheld value is absent from the row; an empty value is null.
  if (value === undefined || value === null) return null;
  const type = valueTypeOf(column.field);
  const invalid = (): never => {
    throw exportFailure(`cell_unreadable:${type}`);
  };
  switch (type) {
    case "text":
    case "long_text":
    case "reference_number":
    case "email_address":
    case "phone_number":
    case "web_address":
      return typeof value === "string" ? { type: "text", value } : invalid();
    case "choice":
      return typeof value === "string"
        ? { type: "text", value: choiceLabels.get(value) ?? value }
        : invalid();
    case "several_choices":
      return Array.isArray(value) && value.every((item) => typeof item === "string")
        ? {
            type: "text",
            value: value.map((item) => choiceLabels.get(item as string) ?? item).join("; "),
          }
        : invalid();
    case "whole_number":
      return typeof value === "number" ? { type: "whole_number", value } : invalid();
    case "decimal_number":
      return typeof value === "string" ? { type: "decimal_number", value } : invalid();
    case "yes_no":
      return typeof value === "boolean" ? { type: "yes_no", value } : invalid();
    case "date":
      return typeof value === "string" ? { type: "date", value } : invalid();
    case "date_time":
      return typeof value === "string" ? { type: "date_time", value } : invalid();
    case "money":
      return isRecord(value) &&
        typeof value.amount === "string" &&
        typeof value.currency === "string"
        ? { type: "money", value: { amount: value.amount, currency: value.currency } }
        : invalid();
    case "link":
    case "link_to_one_of_several": {
      if (
        !isRecord(value) ||
        typeof value.recordTypeId !== "string" ||
        typeof value.recordId !== "string"
      )
        return invalid();
      const title = titles.get(
        recordLinkLabelKey({ recordTypeId: value.recordTypeId, recordId: value.recordId }),
      );
      // A restricted or missing title carries nothing of the record: the cell is empty.
      return title?.kind === "record_link" ? { type: "text", value: title.label } : null;
    }
    default:
      return invalid();
  }
};

const sameField = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

/** The stored value of one field on a row; absent when the viewer's policy withholds it. */
const valueOf = (row: ProtectedQueryRow, fieldId: string): JsonValue | undefined => {
  for (const [key, value] of Object.entries(row.values)) if (sameField(key, fieldId)) return value;
  return undefined;
};

export const createRecordsTableExportService = (dependencies: RecordsTableExportDependencies) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const queries = createProtectedQueryService(dependencies);
  const bulk = createRecordsTableBulkService(dependencies);

  const refuse = (cause: string, detail?: string): undefined => {
    console.error(
      `[records-export] request refused cause=${cause}${detail === undefined ? "" : ` ${detail}`}`,
    );
    return undefined;
  };

  /**
   * The person's effective column arrangement for the placement: their own stored layout, else the
   * saved view the grid showed (a candidate, re-evaluated under their access), else the default
   * view or the authored arrangement, all as the page itself resolves them.
   */
  const effectiveLayout = async (
    transaction: Parameters<Parameters<typeof requests.run>[2]>[0],
    placement: RecordsTablePlacement,
    pageId: string,
    placementId: string,
    viewId: string | undefined,
    readable: ReadonlySet<string> | undefined,
    preview: boolean,
  ): Promise<GridLayout | undefined> => {
    const authored = authoredGridLayout(placement.contract, readable);
    if (authored === undefined || preview) return authored;
    const queryId = String(placement.query.queryId).toLowerCase();
    const savedViews = placement.contract.features.savedViews;
    const key = placementId.toLowerCase();
    const stored = await readGridViews(
      transaction,
      pageId,
      [placementId],
      savedViews.enabled && viewId !== undefined ? [viewId] : [],
      savedViews.enabled
        ? savedViews.defaultViews.map((view) => ({
            viewId: view.viewId,
            queryId,
            document: view.document,
          }))
        : [],
    );
    const own = stored.layouts.get(key);
    let viewLayout: GridLayout | undefined;
    if (savedViews.enabled) {
      const defaults = addressedDefaultGridViews(
        savedViews.defaultViews,
        stored.roleKeys,
        stored.defaultDocuments,
      );
      const automatic =
        own === undefined && viewId === undefined
          ? defaults.find((view) => view.isDefault)
          : undefined;
      const candidate = viewId ?? automatic?.viewId;
      if (candidate !== undefined) {
        const resolved = resolveSelectedGridView(
          authored,
          defaults.find((view) => view.viewId === candidate) ??
            addressedGridView(
              (stored.views.get(key) ?? []).filter((view) => view.queryId === queryId),
              queryId,
              candidate,
              stored.shareable.has(key),
            ),
          readable,
        );
        // A layout the person arranged from this view is theirs; otherwise the view's shows.
        if (resolved.selected !== null && own?.basedOnViewId !== resolved.selected.viewId)
          viewLayout = gridViewLayout(resolved.selected.document);
      }
    }
    return (
      viewLayout ??
      resolveGridLayout(
        authored,
        own === undefined ? undefined : { queryId: own.queryId, layout: own.layout },
        queryId,
      ).layout
    );
  };

  /** One content-free Activity entry; a failure to record it is returned, never swallowed. */
  const audit = async (
    session: IdentitySession,
    address: RecordsTableCommandAddress,
    recordTypeId: string,
    fieldIds: readonly string[],
    action: "started" | "refused" | "finished" | "cancelled" | "incomplete",
  ): Promise<boolean> => {
    const outcome =
      action === "refused" ? "refused" : action === "incomplete" ? "failed" : "completed";
    const canonical = [...new Set(fieldIds.map((fieldId) => fieldId.toLowerCase()))].sort();
    const result = await requests.run(
      session,
      address.selection,
      (transaction) =>
        transaction.query`
        select vortex_record.record_records_export_activity(
          ${randomUUID()}::uuid,
          ${recordTypeId}::uuid,
          array(select pg_catalog.jsonb_array_elements_text(${JSON.stringify(canonical)}::text::jsonb)::uuid),
          ${`records_export_${action}`}::text,
          ${outcome}::text
        )
      `,
    );
    if (result.kind !== "available")
      console.error(`[records-export] activity not recorded action=${action} kind=${result.kind}`);
    return result.kind === "available";
  };

  /** The descriptor of the read the rows were shown from, opened for this person and release. */
  const descriptorFor = (
    session: IdentitySession,
    address: RecordsTableCommandAddress,
    placement: RecordsTablePlacement,
    request: RecordsTableExportRequest,
  ): RecordsSelectionDescriptor | undefined => {
    const token = request.selection.kind === "matching" ? request.selection.token : request.token;
    if (token === undefined) return refuse("descriptor_missing");
    const descriptor = openRecordsSelection(token, dependencies.continuationKey, {
      session,
      selection: address.selection,
      installationRevision: placement.installed.applicationReleaseRevision,
      placementId: request.placementId,
    });
    if (descriptor === undefined) return undefined;
    if (
      !sameId(descriptor.moduleRootId, String(placement.module.rootId)) ||
      !sameId(descriptor.queryId, String(placement.query.queryId))
    )
      return refuse("descriptor_other_query");
    return descriptor;
  };

  return Object.freeze({
    /**
     * Resolves one export and starts its stream. A refusal before any byte is a typed refusal with
     * a safe message for the person; a failure after the first page ends the stream and the
     * returned `outcome` says it was incomplete. `resolveRecordLinks` reads the permitted titles of
     * a page's links in one batch.
     */
    async prepare(
      session: IdentitySession,
      address: RecordsTableCommandAddress,
      request: RecordsTableExportRequest,
      resolveRecordLinks: (context: InstalledRuntimeContext) => RecordLinkResolver,
      signal: AbortSignal,
    ): Promise<
      | Readonly<{
          kind: "ready";
          stream: ReadableStream<Uint8Array>;
          filename: string;
          mediaType: string;
          /** The number of records the selection held when it was resolved. */
          expected: number;
        }>
      | RecordsTableExportRefusal
    > {
      const unavailable: RecordsTableExportRefusal = { kind: "unavailable" };
      const notAvailable: RecordsTableExportRefusal = { kind: "refused", reason: "not_available" };
      const placement = await loadRecordsTablePlacement(
        requests,
        session,
        address,
        request.placementId,
      );
      if ("refused" in placement) {
        refuse(placement.refused);
        return placement.refused === "installation_unavailable" ? unavailable : notAvailable;
      }
      const { installed, contract, recordTypeId } = placement;
      const feature = contract.features.export;
      // Every request is judged again: a disabled export compiles to nothing and is refused here.
      if (!feature.enabled || feature.maxRows === undefined || !feature.formats.includes("csv")) {
        refuse("feature_off");
        return notAvailable;
      }
      const maxRows = feature.maxRows;
      const preview = address.selection.previewInstallationId !== undefined;
      const page = installed.releaseSet.application.content.pages.find(
        (candidate) => candidate.key === request.pageKey,
      );
      if (page === undefined) {
        refuse("page_not_installed");
        return notAvailable;
      }

      // Who may export, which fields, and the arrangement they see, in one request.
      const decided = await requests.run(session, address.selection, async (transaction, scope) => {
        const permission = await decideRecordTypeExport(
          transaction,
          scope,
          installed,
          recordTypeId,
        );
        if (permission.kind === "refused") return permission;
        const readable = preview
          ? undefined
          : await decideRecordTypeFieldIds(transaction, scope, installed, recordTypeId, "read");
        return {
          kind: "permitted" as const,
          exportFieldIds: permission.fieldIds,
          layout: await effectiveLayout(
            transaction,
            placement,
            String(page.pageId),
            request.placementId,
            request.viewId,
            readable,
            preview,
          ),
        };
      });
      if (decided.kind !== "available") {
        refuse(`access_${decided.kind}`);
        return unavailable;
      }
      if (decided.value.kind === "refused") {
        refuse(decided.value.reason);
        await audit(session, address, recordTypeId, [], "refused");
        return notAvailable;
      }
      const { exportFieldIds, layout } = decided.value;
      if (layout === undefined) {
        refuse("layout_unavailable");
        return notAvailable;
      }

      // The exported columns: the visible columns in display order, only fields the person may
      // export and values this file can hold. A field withheld by policy has no column at all.
      const fields = new Map(
        placement.module.content.recordTypes
          .filter((record) => sameId(String(record.recordTypeId), recordTypeId))
          .flatMap((record) => record.fields)
          .map((field) => [String(field.fieldId).toLowerCase(), field] as const),
      );
      const labels = fieldLabelsOf(placement.module);
      const columns: ExportColumn[] = gridLayoutVisibleFieldIds(layout).flatMap((fieldId) => {
        const field = fields.get(fieldId.toLowerCase());
        const declared = contract.columns.find((column) => sameField(column.field, fieldId));
        const label = declared?.label ?? labels[fieldId.toLowerCase()];
        if (
          field === undefined ||
          declared === undefined ||
          label === undefined ||
          !exportableTypes.has(valueTypeOf(field)) ||
          (exportFieldIds !== undefined && !exportFieldIds.has(fieldId.toLowerCase()))
        )
          return [];
        return [{ fieldId: fieldId.toLowerCase(), label, field }];
      });
      if (columns.length === 0) {
        refuse("no_exportable_columns");
        await audit(session, address, recordTypeId, [], "refused");
        return notAvailable;
      }
      const columnIds = columns.map((column) => column.fieldId);

      // The query the rows are read through: the placement's own contract, the descriptor's
      // resolved inputs, and (for every matching record) its sort, filters and search.
      const descriptor = descriptorFor(session, address, placement, request);
      if (descriptor === undefined) {
        await audit(session, address, recordTypeId, columnIds, "refused");
        return { kind: "refused", reason: "changed" };
      }
      const matching = request.selection.kind === "matching";
      const built = buildRecordsTableQueryCommand({
        moduleRootId: placement.module.rootId,
        queryId: placement.query.queryId,
        settings: placement.settings,
        inputValues: descriptor.inputValues as Readonly<Record<string, JsonValue>>,
        state: {
          sort: matching ? (descriptor.sort as unknown as readonly RecordsTableSortKey[]) : [],
          filters: matching
            ? (descriptor.filters as unknown as readonly RecordsTableFilterValue[])
            : [],
          search: matching ? descriptor.search : null,
          page: undefined,
        },
        layout: {
          storage: "preview",
          queryId: String(placement.query.queryId).toLowerCase(),
          revision: null,
          layout,
          authored: layout,
          reset: false,
        },
        filterTargets: fieldFilterTargetsOf(placement.module),
        ...(descriptor.timeZone === undefined ? {} : { timeZone: descriptor.timeZone }),
        fieldLabels: labels,
        fieldChoiceLabels: fieldChoiceLabelsOf(placement.module),
        fieldDateTypes: fieldDateTypesOf(placement.module),
        fieldLinkTypes: fieldLinkTypesOf(placement.module),
      });
      if (built.kind === "refused") {
        refuse(`command_${built.part}_${built.reason}`);
        await audit(session, address, recordTypeId, columnIds, "refused");
        return notAvailable;
      }
      // Only the exported columns are read; a value read only for formatting never leaves.
      const command = { ...built.command, requestedFieldIds: columnIds };
      const pageSize = Math.min(200, placement.query.pageSize);

      // How many records the selection holds, through the one capped count path.
      let expected: number;
      const excluded = new Set(
        request.selection.kind === "matching"
          ? request.selection.excluded.map((recordId) => recordId.toLowerCase())
          : [],
      );
      // The rows the person ticked, each with the revision they saw it at.
      const selectedRevisions = new Map(
        request.selection.kind === "ids"
          ? request.selection.items.map((item) => [item.recordId.toLowerCase(), item.revision])
          : [],
      );
      const selectedIds = [...selectedRevisions.keys()];
      if (request.selection.kind === "ids") expected = selectedIds.length;
      else {
        const counted = await bulk.count(session, address, {
          pageKey: request.pageKey,
          placementId: request.placementId,
          token: request.selection.token,
        });
        if (counted.kind === "unavailable") return unavailable;
        if (counted.kind === "refused") {
          refuse("count_refused");
          await audit(session, address, recordTypeId, columnIds, "refused");
          return notAvailable;
        }
        if (counted.kind === "too_many") {
          refuse("selection_over_count_ceiling");
          await audit(session, address, recordTypeId, columnIds, "refused");
          return { kind: "refused", reason: "too_many", limit: maxRows };
        }
        let stillExcluded = excluded.size;
        // Near the row limit, only unticked records the read still matches may bring the count
        // under it: one gone or changed since would otherwise end the stream short of the limit.
        if (counted.count > maxRows && counted.count - excluded.size <= maxRows) {
          if (descriptor.search !== null) {
            // A single record's read does not apply the search, so its exclusions cannot be
            // confirmed: the selection is judged by what the read matches.
            refuse("selection_over_row_limit", "exclusions_unconfirmed");
            await audit(session, address, recordTypeId, columnIds, "refused");
            return { kind: "refused", reason: "too_many", limit: maxRows, count: counted.count };
          }
          stillExcluded = 0;
          for (const recordId of excluded) {
            const read = await queries.run(session, address.selection, {
              ...command,
              pageSize: 1,
              exactRecordId: recordId,
            });
            if (read.kind !== "available" || read.value.outcome !== "completed") {
              refuse("exclusion_unreadable");
              return unavailable;
            }
            if (read.value.rows.length > 0) stillExcluded += 1;
          }
        }
        expected = Math.max(0, counted.count - stillExcluded);
      }
      if (expected > maxRows) {
        refuse("selection_over_row_limit", `expected=${expected} limit=${maxRows}`);
        await audit(session, address, recordTypeId, columnIds, "refused");
        return { kind: "refused", reason: "too_many", limit: maxRows, count: expected };
      }
      if (expected === 0) {
        refuse("selection_empty");
        await audit(session, address, recordTypeId, columnIds, "refused");
        return { kind: "refused", reason: "changed", count: 0 };
      }
      // Fail closed: an export whose attempt cannot be recorded does not start.
      if (!(await audit(session, address, recordTypeId, columnIds, "started"))) return unavailable;

      const resolveLinks = resolveRecordLinks(installed);
      const choiceLabels = new Map(
        columns.map((column) => [
          column.fieldId,
          new Map(
            (fieldChoiceLabelsOf(placement.module)[column.fieldId] ?? []).map(
              (option) => [option.value, option.label] as const,
            ),
          ),
        ]),
      );
      const linkColumns = columns.filter((column) =>
        ["link", "link_to_one_of_several"].includes(valueTypeOf(column.field)),
      );

      /** The export permission and fields, decided again before each page is written. */
      const recheck = async (): Promise<void> => {
        const current = await requests.run(session, address.selection, (transaction, scope) =>
          decideRecordTypeExport(transaction, scope, installed, recordTypeId),
        );
        if (current.kind !== "available") throw exportFailure(`access_${current.kind}`);
        if (current.value.kind === "refused") throw exportFailure(current.value.reason);
        const allowed = current.value.fieldIds;
        if (allowed !== undefined && columnIds.some((fieldId) => !allowed.has(fieldId)))
          throw exportFailure("export_fields_changed");
      };

      /** One page of protected rows as export cells, with the page's link titles read once. */
      const toPage = async (rows: readonly ProtectedQueryRow[]): Promise<RecordsExportPage> => {
        const links = collectRecordLinkValues(
          linkColumns.flatMap((column) =>
            rows.flatMap((row) => {
              const value = valueOf(row, column.fieldId);
              return value === undefined ? [] : [value];
            }),
          ),
        );
        let titles: ReadonlyMap<string, ProjectedRecordLink> = new Map();
        if (links.length > 0) {
          const read = await resolveLinks(links);
          if (read === undefined) throw exportFailure("link_titles_unavailable");
          titles = read;
        }
        return rows.map((row) =>
          columns.map((column) =>
            cellOf(column, valueOf(row, column.fieldId), choiceLabels.get(column.fieldId)!, titles),
          ),
        );
      };

      const readPage = async (
        extra: Readonly<{ exactRecordId?: string; continuationToken?: string }>,
      ): Promise<Readonly<{ rows: readonly ProtectedQueryRow[]; next: string | undefined }>> => {
        const result = await queries.run(session, address.selection, {
          ...command,
          pageSize: extra.exactRecordId === undefined ? pageSize : 1,
          ...(extra.exactRecordId === undefined ? {} : { exactRecordId: extra.exactRecordId }),
          ...(extra.continuationToken === undefined
            ? {}
            : { pageDirection: "forward" as const, continuationToken: extra.continuationToken }),
        });
        if (result.kind !== "available")
          throw exportFailure(`read_${result.kind}`, "cause" in result ? result.cause : undefined);
        if (result.value.outcome !== "completed")
          throw exportFailure(`read_refused_${result.value.reasonCode}`);
        return { rows: result.value.rows, next: result.value.nextContinuationToken };
      };

      // Shown rows that changed since the person ticked them: exported as they are now, and
      // reported as drift with the outcome.
      let changed = 0;

      async function* pages(pageSignal: AbortSignal): AsyncGenerator<RecordsExportPage> {
        if (request.selection.kind === "ids") {
          // The rows the person ticked, each read under their current access in the order they
          // were shown; a row that is gone or no longer readable is left out, never guessed.
          for (let start = 0; start < selectedIds.length; start += selectedRowsPageSize) {
            const rows: ProtectedQueryRow[] = [];
            for (const recordId of selectedIds.slice(start, start + selectedRowsPageSize)) {
              pageSignal.throwIfAborted();
              if (rows.length === 0) await recheck();
              const read = (await readPage({ exactRecordId: recordId })).rows;
              for (const row of read)
                if (row.revision !== undefined && row.revision !== selectedRevisions.get(recordId))
                  changed += 1;
              rows.push(...read);
            }
            if (rows.length > 0) yield await toPage(rows);
          }
          return;
        }
        // Every matching record: keyset pages in the table's order, once per record.
        const seen = new Set<string>();
        let continuationToken: string | undefined;
        do {
          pageSignal.throwIfAborted();
          await recheck();
          const read = await readPage(continuationToken === undefined ? {} : { continuationToken });
          const fresh = read.rows.filter((row) => {
            const recordId = String(row.recordId).toLowerCase();
            if (excluded.has(recordId) || seen.has(recordId)) return false;
            seen.add(recordId);
            return true;
          });
          continuationToken = read.next;
          if (fresh.length > 0) yield await toPage(fresh);
        } while (continuationToken !== undefined);
      }

      const format: RecordsExportFormat = recordsCsvFormat();
      let prepared: Awaited<ReturnType<typeof prepareRecordsExport>>;
      try {
        prepared = await prepareRecordsExport({
          name: String(placement.query.key),
          labels: columns.map((column) => column.label),
          maxRows,
          format,
          pages,
          signal,
        });
      } catch (cause) {
        const reason = failureReason(cause);
        console.error(`[records-export] not started reason=${reason}`, cause);
        if (signal.aborted) {
          await audit(session, address, recordTypeId, columnIds, "cancelled");
          return unavailable;
        }
        await audit(session, address, recordTypeId, columnIds, "incomplete");
        return reason === "row_limit_exceeded"
          ? { kind: "refused", reason: "too_many", limit: maxRows }
          : reason.startsWith("export_") ||
              reason.startsWith("read_refused_") ||
              reason.startsWith("access_")
            ? notAvailable
            : unavailable;
      }
      void prepared.outcome
        .then(async (outcome: RecordsExportOutcome) => {
          console.info(
            `[records-export] ${outcome.kind} exported=${outcome.exported} expected=${expected} withheld=${Math.max(0, expected - outcome.exported)} changed=${changed} placement=${request.placementId} columns=${columnIds.length}${outcome.kind === "incomplete" ? ` reason=${outcome.reason}` : ""}`,
          );
          await audit(
            session,
            address,
            recordTypeId,
            columnIds,
            outcome.kind === "completed"
              ? "finished"
              : outcome.kind === "cancelled"
                ? "cancelled"
                : "incomplete",
          );
        })
        .catch((cause: unknown) => {
          console.error("[records-export] outcome not recorded", cause);
        });
      return {
        kind: "ready",
        stream: prepared.stream,
        filename: prepared.filename,
        mediaType: prepared.mediaType,
        expected,
      };
    },
  });
};
