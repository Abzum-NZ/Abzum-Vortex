import "server-only";

import {
  fieldIdSchema,
  pastedLinkTitleOf,
  recordsTableBatchEditMaximumRows,
  sameId,
  type IdentitySession,
  type JsonValue,
  type RecordsTableBatchEditProblem,
  type RecordsTableBatchEditRefusalReason,
  type RecordsTableBatchEditRequest,
  type RecordsTableBatchEditResult,
} from "../../schema";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
} from "../../access/index";
import { createRecordSaveService, type RecordBatchSaveProblem } from "../../records/index";
import { createProtectedQueryService, type QueryContinuationKey } from "../../queries/index";
import { fieldEditorsOf } from "../placement-read/shared";
import { pageSubjectFromRead } from "../page-subject-read";
import { inlineEditCellRefusal } from "./flow-dispatch";
import { projectRecordsTableFeatures } from ".";
import {
  loadRecordsTablePlacement,
  type RecordsTableCommandAddress,
  type RecordsTablePlacement,
} from "./placement";
import {
  linkTitleCellKey,
  resolveLinkTitles,
  type LinkTitleDependencies,
  type PastedTitleCell,
} from "./link-title-resolution";
import { recordCommandId } from "./record-command-id";

/**
 * Pasting, filling and undoing cells of a Records table's loaded page. The browser names records
 * (each with the revision it displayed) and the value each changed field takes; it decides
 * nothing. Every cell is decided again here under the person's current access: the feature must be
 * on in the installed placement, the field must be an authored, projected, readable and changeable
 * inline-edit field of the row, the record must still be at the displayed revision, and the value
 * goes through the same type, rule and cascade decisions a single inline edit takes. All records
 * are saved in ONE transaction through the ordinary protected save: every change commits or none
 * does, and a refusal lists every problem found, per record and field.
 *
 * A pasted link arrives as the title the person copied. It is resolved here, before the cell is
 * decided, to the one record of the field's target the person may read; the resolved reference then
 * goes through the same decisions and the same save as a link picked in a cell.
 */
export type RecordsTableBatchEditDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    continuationKey: QueryContinuationKey;
    /** Makes a Studio preview's link target record types readable, as the link picker does. */
    prepareLinkTargets: LinkTitleDependencies["prepareTargets"];
  }>;

const log = (cause: string): void => {
  console.error(`[records-table] batch edit refused cause=${cause}`);
};

const messageOf = (reason: RecordsTableBatchEditRefusalReason): string => {
  switch (reason) {
    case "changed":
      return "This record changed after you loaded it. Reload the page and try again.";
    case "removed":
      return "This record is no longer available to you.";
    case "not_permitted":
      return "You can't change this record.";
    case "not_editable":
      return "This field can't be changed here.";
    case "invalid":
      return "This value isn't valid for the field.";
    case "refused":
      return "This change was refused.";
  }
};

const problem = (
  recordId: string,
  reason: RecordsTableBatchEditRefusalReason,
  field?: string,
  message?: string,
): RecordsTableBatchEditProblem => ({
  recordId: recordId as RecordsTableBatchEditProblem["recordId"],
  ...(field === undefined ? {} : { field: field as RecordsTableBatchEditProblem["field"] }),
  reason,
  message: message ?? messageOf(reason),
});

/** A save problem as the person is told it: a rule's authored words, or the safe wording of its kind. */
const problemOfSave = (saved: RecordBatchSaveProblem): RecordsTableBatchEditProblem => {
  const reason: RecordsTableBatchEditRefusalReason =
    saved.reason === "changed"
      ? "changed"
      : saved.reason === "refused"
        ? "refused"
        : saved.reason === "field_refused"
          ? "not_editable"
          : "invalid";
  return problem(
    saved.recordId,
    reason,
    saved.fieldId,
    saved.reason === "required_value" ? "A value is required." : saved.message,
  );
};

export const createRecordsTableBatchEditService = (
  dependencies: RecordsTableBatchEditDependencies,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const records = createRecordSaveService(dependencies);
  const queries = createProtectedQueryService(dependencies);

  /** The feature switches of the installed placement, and what the request may name. */
  const placementFor = async (
    session: IdentitySession,
    address: RecordsTableCommandAddress,
    request: RecordsTableBatchEditRequest,
  ): Promise<RecordsTablePlacement | undefined> => {
    const loaded = await loadRecordsTablePlacement(requests, session, address, request.placementId);
    if ("refused" in loaded) return log(loaded.refused) as undefined;
    const { inlineEdit, spreadsheet } = loaded.contract.features;
    if (
      !inlineEdit.enabled ||
      !spreadsheet.enabled ||
      spreadsheet.rangeSelect !== true ||
      (spreadsheet.paste !== true && spreadsheet.fill !== true && spreadsheet.undo !== true)
    )
      return log("feature_off") as undefined;
    return loaded;
  };

  return Object.freeze({
    async run(
      session: IdentitySession,
      address: RecordsTableCommandAddress,
      request: RecordsTableBatchEditRequest,
    ): Promise<RecordsTableBatchEditResult> {
      const placement = await placementFor(session, address, request);
      if (placement === undefined) return { kind: "unavailable" };
      const { contract, module, installed, recordTypeId } = placement;
      const inline = contract.features.inlineEdit;
      if (!inline.enabled) return { kind: "unavailable" };

      // The request's own shape: at most one page of distinct records, and only fields the table
      // authors for inline editing and shows as columns.
      const recordIds = request.rows.map((row) => row.recordId as string);
      if (
        request.rows.length > recordsTableBatchEditMaximumRows ||
        new Set(recordIds.map((id) => id.toLowerCase())).size !== recordIds.length
      ) {
        log("rows_invalid");
        return { kind: "unavailable" };
      }
      for (const row of request.rows)
        for (const field of Object.keys(row.values))
          if (
            !fieldIdSchema.safeParse(field).success ||
            !inline.fields.some((allowed) => sameId(allowed, field)) ||
            !contract.columns.some((column) => sameId(column.field, field))
          ) {
            log(`field_not_editable:${field}`);
            return { kind: "unavailable" };
          }

      // Every record is read in one database call under the person's current access; the change
      // is decided against what is there now, never against the browser's page.
      const editors = fieldEditorsOf(module, installed.releaseSet.modules);
      const read = await requests.run(
        session,
        address.selection,
        async (transaction) =>
          transaction.query<{ record_id: string; record: unknown; capabilities: unknown }>`
          select target.value::uuid as record_id,
            vortex_record.read_record(${recordTypeId}::uuid, target.value::uuid) as record,
            vortex_record.read_record_capabilities(${recordTypeId}::uuid, target.value::uuid) as capabilities
          from pg_catalog.jsonb_array_elements_text(${JSON.stringify(recordIds)}::text::jsonb) as target(value)
        `,
      );
      if (read.kind !== "available") return { kind: "unavailable" };
      const rows = new Map(read.value.map((entry) => [entry.record_id.toLowerCase(), entry]));
      const problems: RecordsTableBatchEditProblem[] = [];
      const pasted: PastedTitleCell[] = [];
      const known = new Map<
        string,
        {
          stored: Readonly<Record<string, unknown>>;
          submitted: Readonly<Record<string, JsonValue>>;
        }
      >();
      for (const submitted of request.rows) {
        const stored = rows.get((submitted.recordId as string).toLowerCase());
        const current =
          stored === undefined
            ? undefined
            : pageSubjectFromRead(stored.record, stored.capabilities, stored.record_id);
        if (current?.kind !== "read") {
          log(`record_not_readable:${submitted.recordId}`);
          problems.push(problem(submitted.recordId, "removed"));
          continue;
        }
        const row = current.row;
        known.set((submitted.recordId as string).toLowerCase(), {
          stored: row.values,
          submitted: submitted.values as Readonly<Record<string, JsonValue>>,
        });
        if (row.revision !== submitted.revision) {
          log(`revision_not_current:${submitted.recordId}`);
          problems.push(problem(submitted.recordId, "changed"));
          continue;
        }
        const projected = projectRecordsTableFeatures(
          contract,
          {
            readableFieldIds: Object.keys(row.values).map((field) => fieldIdSchema.parse(field)),
            searchable: false,
          },
          [row],
          undefined,
          editors,
        );
        for (const [field, submittedValue] of Object.entries(submitted.values)) {
          // A pasted title is decided as the link it will become; the reference is not known yet.
          const title = pastedLinkTitleOf(submittedValue);
          const value = title === undefined ? submittedValue : null;
          const cause = !projected?.inlineEdit?.fields.some((allowed) =>
            sameId(allowed.field, field),
          )
            ? `field_not_projected:${field}`
            : inlineEditCellRefusal(row, field, editors, value);
          if (cause === undefined) {
            if (title !== undefined) pasted.push({ recordId: submitted.recordId, field, title });
            continue;
          }
          log(`${cause}:${submitted.recordId}`);
          problems.push(
            problem(
              submitted.recordId,
              row.capabilities?.actions.includes("update") === true
                ? "not_editable"
                : "not_permitted",
              field,
            ),
          );
        }
      }

      // Every pasted title of the batch is resolved in one read per link field (per parent for a
      // dependent link).
      const resolved = await resolveLinkTitles(
        {
          queries,
          prepareTargets: dependencies.prepareLinkTargets,
        },
        session,
        address.selection,
        installed,
        module,
        recordTypeId,
        pasted,
        known,
      );
      if (resolved.unavailable) return { kind: "unavailable" };
      for (const refused of resolved.problems)
        problems.push(problem(refused.recordId, "invalid", refused.field, refused.message));
      if (problems.length > 0) return { kind: "refused", reason: "not_available", problems };
      // Every pasted title is now a reference; a title left unresolved never reaches the save.
      if (
        pasted.some((cell) => !resolved.references.has(linkTitleCellKey(cell.recordId, cell.field)))
      ) {
        log("link_title_unresolved");
        return { kind: "unavailable" };
      }
      const valuesOf = (row: RecordsTableBatchEditRequest["rows"][number]) =>
        Object.fromEntries(
          Object.entries(row.values).map(([field, value]) => [
            field,
            pastedLinkTitleOf(value) === undefined
              ? value
              : resolved.references.get(linkTitleCellKey(row.recordId, field)),
          ]),
        ) as Readonly<Record<string, JsonValue>>;

      const saved = await records.saveBatch(
        session,
        address.selection,
        recordTypeId,
        request.rows.map((row) => ({
          commandId: recordCommandId("records.batch-edit", request.commandId, row.recordId),
          recordId: row.recordId,
          expectedConcurrencyNumber: row.revision,
          submittedValues: valuesOf(row),
        })),
      );
      if (saved.kind === "refused")
        return {
          kind: "refused",
          reason: "not_available",
          problems: saved.problems.map(problemOfSave),
        };
      if (saved.kind !== "saved") return { kind: "unavailable" };
      return {
        kind: "saved",
        rows: saved.rows.map((row) => ({
          recordId: row.recordId as RecordsTableBatchEditProblem["recordId"],
          revision: row.concurrencyNumber,
          previous: row.previous as Record<string, never>,
        })),
      };
    },
  });
};
