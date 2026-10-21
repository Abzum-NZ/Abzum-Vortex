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
 * listing read of the field's target record type for all of the field's distinct titles (the Query
 * engine admits only the records the person may read and applies the field read policy, so a title
 * they may not read never matches), with a title matching exactly one record becoming that record's
 * reference and any other count a problem naming the cell. A dependent link (Region on Country) is
 * read narrowed to the row's effective parent, the one pasted in the same row or else the stored
 * one, exactly as the link picker narrows: one read per distinct parent of the paste (bounded), and
 * one unnarrowed read only to tell a title under another parent from a title nobody may read. The
 * save's own cascade check stays the authority. Nothing is guessed: the match is exact on the
 * trimmed title as stored.
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
const pagesPerRead = 5;
const pageSize = 200;
/** A dependent link is read once per distinct parent in the paste, up to this many parents. */
const parentsPerField = 20;

type Reference = Readonly<{ recordTypeId: string; recordId: string }>;

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

    // A number title only ever equals a number, so other text is left out of a read and matches
    // nothing.
    const numeric = titleField.type === "whole_number" || titleField.type === "decimal_number";
    const titleIn = (titles: readonly string[]) =>
      ({
        kind: "comparison",
        operator: "in",
        left: { source: "field", fieldId: fieldIdSchema.parse(titleFieldId) },
        right: { source: "value", value: [...titles] },
      }) as const;
    /**
     * One set-based read of the given titles, narrowed for a dependent link to the records whose
     * filter link points at one parent (the link picker's own narrowing): title -> record ids.
     */
    const read = async (
      titles: readonly string[],
      parent: Reference | undefined,
    ): Promise<Map<string, string[]> | "too_many" | "unavailable"> => {
      const byTitle = new Map<string, string[]>();
      const wanted = titles.filter((title) => !numeric || Number.isFinite(Number(title)));
      const narrowed = parent !== undefined && filterFieldId !== undefined;
      let token: string | undefined;
      for (let page = 0; wanted.length > 0; page += 1) {
        if (page === pagesPerRead) return "too_many";
        const command = {
          moduleRootId: moduleRootIdSchema.parse(String(targetModule.rootId)),
          queryId: queryIdSchema.parse(String(targetType.recordTypeId)),
          inputValues: {},
          requestedFieldIds: [fieldIdSchema.parse(titleFieldId)],
          requestedSystemFieldKeys: [],
          sort: [],
          sortableFieldIds: [],
          filterableFieldIds: [titleFieldId, ...(narrowed ? [filterFieldId] : [])].map((id) =>
            fieldIdSchema.parse(id),
          ),
          searchableFieldIds: [],
          filter: !narrowed
            ? titleIn(wanted)
            : {
                kind: "all",
                conditions: [
                  titleIn(wanted),
                  {
                    kind: "comparison",
                    operator: "in",
                    left: { source: "field", fieldId: fieldIdSchema.parse(filterFieldId) },
                    right: {
                      source: "value",
                      value: [
                        {
                          recordTypeId: parent.recordTypeId.toLowerCase(),
                          recordId: parent.recordId,
                        },
                      ],
                    },
                  },
                ],
              },
          pageSize,
          ...(token === undefined ? {} : { continuationToken: token }),
        } as ProtectedQueryCommand;
        const result = await dependencies.queries.run(session, selection, command);
        if (result.kind !== "available" || result.value.outcome !== "completed") {
          console.error(
            `[records-table] batch edit refused cause=link_title_read field=${field} outcome=${
              result.kind !== "available"
                ? result.kind
                : result.value.outcome === "refused"
                  ? `refused:${result.value.reasonCode}`
                  : result.value.outcome
            }`,
          );
          return "unavailable";
        }
        for (const row of result.value.rows) {
          const title = titleText(valueOf(row.values, titleFieldId) as JsonValue | undefined);
          byTitle.set(title, [...(byTitle.get(title) ?? []), row.recordId]);
        }
        token = result.value.nextContinuationToken;
        if (token === undefined) break;
      }
      return byTitle;
    };
    const tooMany = (cell: PastedTitleCell): void =>
      problemOf(
        cell,
        "link_title_too_many",
        `There are too many ${targetType.pluralLabel} to match these titles here. Pick the ${labelOf(field)} in the cells instead.`,
      );

    // Every cell's parent for a dependent link: the one pasted in the same row (resolved above) or
    // else the stored one; a cell whose parent is missing is named and not read.
    const parentField = dependency === undefined ? undefined : String(dependency.parentFieldId);
    const pending: Array<Readonly<{ cell: PastedTitleCell; parent: Reference | undefined }>> = [];
    for (const cell of fieldCells) {
      if (parentField === undefined) {
        pending.push({ cell, parent: undefined });
        continue;
      }
      const row = rows.get(cell.recordId.toLowerCase());
      const submitted = row === undefined ? undefined : valueOf(row.submitted, parentField);
      const parent =
        submitted === undefined
          ? referenceOf(row === undefined ? undefined : valueOf(row.stored, parentField))
          : submitted === null
            ? undefined
            : (references.get(linkTitleCellKey(cell.recordId, parentField)) ??
              referenceOf(submitted));
      // A pasted parent that did not resolve is already named; its child waits for it.
      if (submitted !== undefined && submitted !== null && parent === undefined) continue;
      if (parent === undefined)
        problemOf(
          cell,
          "link_title_parent",
          `Choose ${labelOf(parentField)} before ${labelOf(field)}.`,
        );
      else pending.push({ cell, parent });
    }
    if (pending.length === 0) continue;

    // One read per field; a dependent link reads once per distinct parent (bounded) plus once
    // unnarrowed, which tells a title under another parent from a title nobody may read.
    const groups = new Map<string, { parent: Reference | undefined; cells: PastedTitleCell[] }>();
    for (const { cell, parent } of pending) {
      const key = parent === undefined ? "" : parent.recordId.toLowerCase();
      const group = groups.get(key) ?? { parent, cells: [] };
      group.cells.push(cell);
      groups.set(key, group);
    }
    if (groups.size > parentsPerField) {
      for (const { cell } of pending) tooMany(cell);
      continue;
    }
    const unmatched: PastedTitleCell[] = [];
    for (const { parent, cells: groupCells } of groups.values()) {
      const byTitle = await read([...new Set(groupCells.map((cell) => cell.title))], parent);
      if (byTitle === "unavailable") return { references, problems, unavailable: true };
      for (const cell of groupCells) {
        if (byTitle === "too_many") {
          tooMany(cell);
          continue;
        }
        const candidates = byTitle.get(cell.title) ?? [];
        if (candidates.length === 1)
          references.set(linkTitleCellKey(cell.recordId, field), {
            recordTypeId: String(targetType.recordTypeId),
            recordId: candidates[0]!,
          });
        else if (candidates.length > 1)
          problemOf(
            cell,
            "link_title_several",
            `Several ${targetType.pluralLabel} are called "${cell.title}". Pick one in the cell.`,
          );
        else unmatched.push(cell);
      }
    }
    if (unmatched.length === 0) continue;
    const anywhere =
      parentField === undefined
        ? undefined
        : await read([...new Set(unmatched.map((cell) => cell.title))], undefined);
    if (anywhere === "unavailable") return { references, problems, unavailable: true };
    for (const cell of unmatched)
      if (parentField !== undefined && anywhere instanceof Map && anywhere.has(cell.title))
        // The title names records the person may read, none of them under this row's parent.
        problemOf(
          cell,
          "link_title_parent",
          `"${cell.title}" is not one of the ${targetType.pluralLabel} of this ${labelOf(parentField)}.`,
        );
      else
        problemOf(
          cell,
          "link_title_none",
          `No ${targetLabel} called "${cell.title}" that you can see.`,
        );
  }
  return { references, problems, unavailable: false };
};
