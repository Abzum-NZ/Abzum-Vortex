import "server-only";

import {
  previewDemandSchema,
  sameId,
  type ApplicationContent,
  type ConditionNode,
  type ModuleContent,
  type PageDefinition,
  type PreviewDemand,
} from "@vortex/platform/schema";
import type { collectPlacements } from "./application-page/placement-helpers";

type Module = Readonly<{ content: ModuleContent }>;
type Query = ApplicationContent["queries"][number];
type Selection =
  | Readonly<{ kind: "query"; query: Query }>
  | Readonly<{
      kind: "placements";
      page: PageDefinition;
      readSubject: boolean;
      placements: ReturnType<typeof collectPlacements>;
    }>
  | Readonly<{ kind: "choices"; recordTypeIds: readonly string[] }>;

/**
 * The one pure demand derivation for canvas areas, Records and runtime preview pages. A demand
 * describes only visible reads; SQL expands it through totals, relationships and live access.
 */
export const studioPreviewDemand = (
  application: ApplicationContent,
  modules: readonly Module[],
  selection: Selection,
): PreviewDemand | undefined => {
  const types = new Map<
    string,
    { recordTypeId: string; fieldIds: Set<string>; relationshipPaths: string[][] }
  >();
  const add = (recordTypeId: string, fieldIds: readonly string[]) => {
    const record = modules
      .flatMap((module) => module.content.recordTypes)
      .find((candidate) => sameId(candidate.recordTypeId, recordTypeId));
    if (record === undefined) throw new Error("STUDIO_PREVIEW_DEMAND_RECORD_TYPE_MISSING");
    // System projections read their live source; a preview has no copied storage for them.
    if (record.systemProjection !== undefined) return;
    const id = recordTypeId.toLowerCase();
    const entry = types.get(id) ?? {
      recordTypeId: id,
      fieldIds: new Set<string>(),
      relationshipPaths: [],
    };
    for (const field of fieldIds) entry.fieldIds.add(field.toLowerCase());
    types.set(id, entry);
  };
  const queryDemand = (query: Query) => {
    if (query.recordType.state !== "resolved")
      throw new Error("STUDIO_PREVIEW_DEMAND_UNRESOLVED_QUERY");
    const fields = new Set<string>([
      ...query.selectedFieldIds,
      ...query.groupByFieldIds,
      ...query.sort.map((sort) => sort.fieldId),
      ...query.aggregates.flatMap((aggregate) =>
        aggregate.fieldId === undefined ? [] : [aggregate.fieldId],
      ),
    ]);
    const condition = (node: ConditionNode): void => {
      if (node.kind === "comparison") {
        if (node.left.source === "field") fields.add(node.left.fieldId);
        if (node.right?.source === "field") fields.add(node.right.fieldId);
      } else if (node.kind === "not") condition(node.condition);
      else node.conditions.forEach(condition);
    };
    if (query.filter != null) condition(query.filter);
    add(query.recordType.recordTypeId, [...fields]);
  };
  if (selection.kind === "query") {
    queryDemand(selection.query);
  } else if (selection.kind === "choices") {
    for (const id of selection.recordTypeIds) {
      const record = modules
        .flatMap((module) => module.content.recordTypes)
        .find((candidate) => sameId(candidate.recordTypeId, id));
      if (record === undefined) throw new Error("STUDIO_PREVIEW_DEMAND_CHOICE_TYPE_MISSING");
      add(record.recordTypeId, [record.titleFieldId]);
    }
  } else {
    for (const placement of selection.placements) {
      if (typeof placement.vortex.queryId !== "string") continue;
      const queryId = placement.vortex.queryId;
      const query = [
        ...application.queries,
        ...modules.flatMap((module) => module.content.queries),
      ].find((candidate) => sameId(candidate.queryId, queryId));
      if (query === undefined) throw new Error("STUDIO_PREVIEW_DEMAND_QUERY_MISSING");
      queryDemand(query);
    }
    const subject = "recordType" in selection.page ? selection.page.recordType : undefined;
    if (selection.readSubject && subject?.state === "resolved") {
      const record = modules
        .flatMap((module) => module.content.recordTypes)
        .find((candidate) => sameId(candidate.recordTypeId, subject.recordTypeId));
      if (record === undefined) throw new Error("STUDIO_PREVIEW_DEMAND_SUBJECT_MISSING");
      add(
        record.recordTypeId,
        record.fields.map((field) => field.fieldId),
      );
    }
  }
  if (types.size === 0) return undefined;
  // Query predicates and sorts currently name fields directly. Relationship-field targets are
  // expanded by SQL from fieldIds; no traversal path is authored in the query contract.
  return previewDemandSchema.parse({
    recordTypes: [...types.values()]
      .sort((a, b) => a.recordTypeId.localeCompare(b.recordTypeId))
      .map((entry) => ({ ...entry, fieldIds: [...entry.fieldIds].sort() })),
  });
};
