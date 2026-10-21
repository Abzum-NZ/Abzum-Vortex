import "server-only";

import {
  fieldIdSchema,
  isRecord,
  moduleRootIdSchema,
  queryIdSchema,
  sameId,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
} from "../../schema";
import type { InstalledRuntimeContext } from "../../definition/index";
import {
  titleText,
  type createProtectedQueryService,
  type ProtectedQueryCommand,
} from "../../queries/index";
import type { PlacementModule } from "../placement-read/shared";

/**
 * Pasted link titles of one batch, resolved to the records they name. Every link cell the paste
 * carries as a title is resolved here, on the server, per person and per field: ONE protected
 * listing read of the field's target record type per link field (the Query engine admits only the
 * records the person may read and applies the field read policy, so a title they may not read never
 * matches), with a title matching exactly one record becoming that record's reference and any other
 * count a problem naming the cell. A dependent link (Region on Country) matches only among records
 * whose declared filter link points at the row's effective parent, the one pasted in the same row
 * or else the stored one; the save's own cascade check stays the authority. Nothing is guessed:
 * the match is exact on the trimmed title as stored.
 */

/** One pasted title: where it goes and what it says. */
export type PastedTitleCell = Readonly<{
  recordId: string;
  field: string;
  title: string;
}>;

/** A cell the paste could not resolve, with the sentence the person is told. */
export type LinkTitleProblem = Readonly<{
  recordId: string;
  field: string;
  /** For the server log; never carries a title or an id. */
  cause:
    | "link_title_none"
    | "link_title_several"
    | "link_title_too_many"
    | "link_title_parent"
    | "link_title_not_filterable";
  message: string;
}>;

export type LinkTitleResolution = Readonly<{
  /** Resolved references by `cellKey`. */
  references: ReadonlyMap<string, Readonly<{ recordTypeId: string; recordId: string }>>;
  problems: readonly LinkTitleProblem[];
  /** True when the reads could not be made; nothing is known and the paste may be sent again. */
  unavailable: boolean;
}>;

export const linkTitleCellKey = (recordId: string, field: string): string =>
  `${recordId.toLowerCase()}|${field.toLowerCase()}`;

/** A listing page holds up to 200 records; a title read follows at most this many pages. */
const pagesPerField = 5;
const pageSize = 200;

export type LinkTitleDependencies = Readonly<{
  queries: ReturnType<typeof createProtectedQueryService>;
  /** Makes a Studio preview's target record types readable, as the link picker does. */
  prepareTargets: (
    session: IdentitySession,
    installed: InstalledRuntimeContext,
    recordTypeIds: readonly string[],
  ) => Promise<"ready" | "refused" | "temporarily_unavailable">;
}>;

const referenceOf = (
  value: unknown,
): Readonly<{ recordTypeId: string; recordId: string }> | undefined =>
  isRecord(value) && typeof value.recordTypeId === "string" && typeof value.recordId === "string"
    ? { recordTypeId: value.recordTypeId, recordId: value.recordId }
    : undefined;

const valueOf = (values: Readonly<Record<string, unknown>>, field: string): unknown => {
  const key = Object.keys(values).find((candidate) => sameId(candidate, field));
  return key === undefined ? undefined : values[key];
};

export const resolveLinkTitles = async (
  dependencies: LinkTitleDependencies,
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  installed: InstalledRuntimeContext,
  module: PlacementModule,
  recordTypeId: string,
  cells: readonly PastedTitleCell[],
  /** What each record holds now and what the batch submits for it (a pasted title as `{ pastedTitle }`). */
  rows: ReadonlyMap<
    string,
    Readonly<{
      stored: Readonly<Record<string, unknown>>;
      submitted: Readonly<Record<string, JsonValue>>;
    }>
  >,
): Promise<LinkTitleResolution> => {
  const references = new Map<string, Readonly<{ recordTypeId: string; recordId: string }>>();
  const problems: LinkTitleProblem[] = [];
  if (cells.length === 0) return { references, problems, unavailable: false };
  const source = module.content.recordTypes.find((candidate) =>
    sameId(String(candidate.recordTypeId), recordTypeId),
  );
  const modules = installed.releaseSet.modules;
  const labelOf = (field: string): string =>
    source?.fields.find((candidate) => sameId(String(candidate.fieldId), field))?.label ??
    "the field";
  const problemOf = (
    cell: PastedTitleCell,
    cause: LinkTitleProblem["cause"],
    message: string,
  ): void => {
    console.error(`[records-table] batch edit refused cause=${cause} field=${cell.field}`);
    problems.push({ recordId: cell.recordId, field: cell.field, cause, message });
  };

  const linkField = (field: string) => {
    const definition = source?.fields.find((candidate) => sameId(String(candidate.fieldId), field));
    return definition?.type === "link" && definition.settings.target.state === "resolved"
      ? definition
      : undefined;
  };
  // A dependent link resolves after the field it depends on, so a parent pasted in the same batch
  // is known first.
  const depthOf = (field: string, seen = 0): number => {
    const parent = linkField(field)?.settings.dependsOn?.parentFieldId;
    return parent === undefined || seen > 8 ? 0 : 1 + depthOf(String(parent), seen + 1);
  };
  const fields = [...new Set(cells.map((cell) => cell.field.toLowerCase()))].sort(
    (left, right) => depthOf(left) - depthOf(right),
  );

  // The record types the reads touch must be readable first (a Studio preview materialises them).
  const targets = fields.flatMap((field) => {
    const definition = linkField(field);
    if (definition === undefined || definition.settings.target.state !== "resolved") return [];
    const target = definition.settings.target;
    const targetModule = modules.find((candidate) =>
      sameId(String(candidate.rootId), String(target.moduleRootId)),
    );
    const targetType = targetModule?.content.recordTypes.find((candidate) =>
      sameId(String(candidate.recordTypeId), String(target.recordTypeId)),
    );
    return targetModule === undefined || targetType === undefined
      ? []
      : [{ field, definition, targetModule, targetType }];
  });
  const prepared =
    targets.length === 0
      ? "ready"
      : await dependencies.prepareTargets(
          session,
          installed,
          targets.map(({ targetType }) => String(targetType.recordTypeId)),
        );
  if (prepared !== "ready") return { references, problems, unavailable: true };

  for (const field of fields) {
    const target = targets.find((candidate) => candidate.field === field);
    const fieldCells = cells.filter((cell) => cell.field.toLowerCase() === field);
    if (target === undefined) {
      for (const cell of fieldCells)
        problemOf(cell, "link_title_none", `${labelOf(field)} can't be filled from a title here.`);
      continue;
    }
    const { definition, targetModule, targetType } = target;
    const titleFieldId = String(targetType.titleFieldId);
    const dependency = definition.settings.dependsOn;
    const filterFieldId = dependency === undefined ? undefined : String(dependency.filterFieldId);
    const targetLabel = targetType.singularLabel;
    const titleField = targetType.fields.find((candidate) =>
      sameId(String(candidate.fieldId), titleFieldId),
    );
    // The Query engine matches only a filterable field; a title it cannot filter is named per cell.
    if (titleField?.filterable !== true) {
      for (const cell of fieldCells)
        problemOf(
          cell,
          "link_title_not_filterable",
          `${targetType.pluralLabel} can't be found by title here. Pick the ${labelOf(field)} in the cell.`,
        );
      continue;
    }

    // One set-based read: every distinct title of the batch for this field. A number title only
    // ever equals a number, so other text is left out of the read and matches nothing.
    const numeric = titleField.type === "whole_number" || titleField.type === "decimal_number";
    const titles = [...new Set(fieldCells.map((cell) => cell.title))].filter(
      (title) => !numeric || Number.isFinite(Number(title)),
    );
    const byTitle = new Map<
      string,
      Array<Readonly<{ recordId: string; parentRecordId: string | undefined }>>
    >();
    let tooMany = false;
    let token: string | undefined;
    for (let page = 0; titles.length > 0 && page < pagesPerField; page += 1) {
      const command: ProtectedQueryCommand = {
        moduleRootId: moduleRootIdSchema.parse(String(targetModule.rootId)),
        queryId: queryIdSchema.parse(String(targetType.recordTypeId)),
        inputValues: {},
        requestedFieldIds: [
          titleFieldId,
          ...(filterFieldId === undefined ? [] : [filterFieldId]),
        ].map((id) => fieldIdSchema.parse(id)),
        requestedSystemFieldKeys: [],
        sort: [],
        sortableFieldIds: [],
        filterableFieldIds: [fieldIdSchema.parse(titleFieldId)],
        searchableFieldIds: [],
        filter: {
          kind: "comparison",
          operator: "in",
          left: { source: "field", fieldId: fieldIdSchema.parse(titleFieldId) },
          right: { source: "value", value: titles },
        },
        pageSize,
        ...(token === undefined ? {} : { continuationToken: token }),
      } as ProtectedQueryCommand;
      const result = await dependencies.queries.run(session, selection, command);
      if (result.kind !== "available" || result.value.outcome !== "completed") {
        console.error(
          `[records-table] batch edit refused cause=link_title_read field=${field} outcome=${
            result.kind === "available" ? result.value.outcome : result.kind
          }`,
        );
        return { references, problems, unavailable: true };
      }
      for (const row of result.value.rows) {
        const title = titleText(valueOf(row.values, titleFieldId) as JsonValue | undefined);
        const parent =
          filterFieldId === undefined
            ? undefined
            : referenceOf(valueOf(row.values, filterFieldId))?.recordId;
        const list = byTitle.get(title) ?? [];
        list.push({ recordId: row.recordId, parentRecordId: parent });
        byTitle.set(title, list);
      }
      token = result.value.nextContinuationToken;
      if (token === undefined) break;
      if (page === pagesPerField - 1) tooMany = true;
    }
    if (tooMany) {
      for (const cell of fieldCells)
        problemOf(
          cell,
          "link_title_too_many",
          `There are too many ${targetType.pluralLabel} to match these titles here. Pick the ${labelOf(field)} in the cells instead.`,
        );
      continue;
    }

    for (const cell of fieldCells) {
      let candidates = byTitle.get(cell.title) ?? [];
      if (dependency !== undefined) {
        const row = rows.get(cell.recordId.toLowerCase());
        const parentField = String(dependency.parentFieldId);
        const submitted = row === undefined ? undefined : valueOf(row.submitted, parentField);
        const parent =
          submitted === undefined
            ? referenceOf(row === undefined ? undefined : valueOf(row.stored, parentField))
            : submitted === null
              ? undefined
              : (references.get(linkTitleCellKey(cell.recordId, parentField)) ??
                referenceOf(submitted));
        if (submitted !== undefined && submitted !== null && parent === undefined) continue;
        if (parent === undefined) {
          problemOf(
            cell,
            "link_title_parent",
            `Choose ${labelOf(parentField)} before ${labelOf(field)}.`,
          );
          continue;
        }
        candidates = candidates.filter(
          (candidate) =>
            candidate.parentRecordId !== undefined &&
            sameId(candidate.parentRecordId, parent.recordId),
        );
      }
      if (candidates.length === 1)
        references.set(linkTitleCellKey(cell.recordId, field), {
          recordTypeId: String(targetType.recordTypeId),
          recordId: candidates[0]!.recordId,
        });
      else if (candidates.length === 0)
        problemOf(
          cell,
          "link_title_none",
          `No ${targetLabel} called "${cell.title}" that you can see.`,
        );
      else
        problemOf(
          cell,
          "link_title_several",
          `Several ${targetType.pluralLabel} are called "${cell.title}". Pick one in the cell.`,
        );
    }
  }
  return { references, problems, unavailable: false };
};
