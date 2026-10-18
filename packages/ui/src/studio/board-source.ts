import {
  boardBlockSourceIsSupported,
  readBoardPlacementContract,
  type ApplicationSourceDocument,
  type BlockPropertyValueContract,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import { uniqueKey } from "./application-structure-common";

/** The release key of the Board block, whose query publication judges with `boardBlockSourceIsSupported`. */
export const boardBlockKey = "platform.display.board";

/** Pipeline choices name the stage field; a board never guesses from a page's filtered query. */
export const studioBoardPipelines = (source: ApplicationSourceDocument) =>
  source.body.modules.flatMap((module) => module.record_types.flatMap((record) =>
    record.pipelines.flatMap((pipeline) => {
      const stage = record.fields.find((field) => field.key === pipeline.stage_field);
      const title = record.fields.find((field) => field.key === record.title_field);
      return stage?.type !== "choice" || !stage.filterable || title === undefined ? [] : [{
        reference: `${module.key}:${record.key}.${stage.key}`,
        label: `${record.plural_name}: ${pipeline.name}`,
        titleField: `${module.key}:${record.key}.${title.key}`,
        fields: record.fields.map((field) => ({ reference: `${module.key}:${record.key}.${field.key}`,
          label: field.label, type: field.type })),
      }];
    })));

/** Writes an ordinary unfiltered grouped query, editable in Data like any other query. */
export const createStudioBoardQuery = (source: ApplicationSourceDocument,
  settings: Readonly<Record<string, SourceBlockPropertyValueContract>>, taken: ReadonlySet<string>): string | undefined => {
  const field = settings.choice_field;
  if (field?.kind !== "field_reference") return undefined;
  const pipeline = studioBoardPipelines(source).find((candidate) => candidate.reference === field.field);
  if (pipeline === undefined) return undefined;
  const [moduleKey, rest] = field.field.split(":");
  const [recordKey, stageKey] = rest!.split(".");
  const module = source.body.modules.find((candidate) => candidate.key === moduleKey)!;
  const record = module.record_types.find((candidate) => candidate.key === recordKey)!;
  const selected = record.fields.map((candidate) => candidate.key);
  const existing = module.queries.find((query) => query.record_type === record.key && query.filter === null &&
    query.inputs.length === 0 && query.group_by.length === 1 && query.group_by[0] === stageKey &&
    query.relationship_hops === 0 && query.aggregates.length === 0 &&
    selected.every((key) => query.select.includes(key)));
  if (existing !== undefined) return `${module.key}:${existing.key}`;
  if (module.queries.length >= 100) return undefined;
  const key = uniqueKey(`${record.key}_by_${stageKey}`, "", new Set(module.queries.map((query) => query.key)), 40);
  const id = uniqueKey(`qry_${key}`, "", taken, 160);
  module.queries.push({ id, key, label: pipeline.label, record_type: record.key,
    inputs: [], select: selected, filter: null, group_by: [stageKey!], aggregates: [],
    sort: [{ field: stageKey!, direction: "ascending" }], page_size: 40, relationship_hops: 0 });
  return `${module.key}:${key}`;
};

/**
 * Why a Board cannot read this query, judged by the same reader and rule publication applies
 * (`readBoardPlacementContract`, `boardBlockSourceIsSupported`) over the draft's own query and
 * record type. The rule reads field identities, so each qualified field reference of the draft
 * stands in as one stable identity for this check. Undefined when the Board can read it. A query of
 * a Module the application only uses is judged at publication.
 */
export const studioBoardSourceProblem = (
  source: ApplicationSourceDocument,
  settings: Readonly<Record<string, SourceBlockPropertyValueContract>>,
  queryReference: string | null,
): string | undefined => {
  const identities = new Map<string, string>();
  const identity = (reference: string): string => {
    let id = identities.get(reference);
    if (id === undefined) {
      id = `00000000-0000-4000-8000-${(identities.size + 1).toString(16).padStart(12, "0")}`;
      identities.set(reference, id);
    }
    return id;
  };
  const canonical = (value: SourceBlockPropertyValueContract): BlockPropertyValueContract =>
    value.kind === "field_reference" ? { kind: "field_reference", fieldId: identity(value.field) as never }
      : value.kind === "group" ? { kind: "group", properties: Object.fromEntries(
          Object.entries(value.properties).map(([key, nested]) => [key, canonical(nested)])) }
        : value.kind === "list" ? { kind: "list", items: value.items.map(canonical) }
          : value as BlockPropertyValueContract;
  const contract = readBoardPlacementContract(Object.fromEntries(
    Object.entries(settings).map(([key, value]) => [key, canonical(value)])));
  if (contract === undefined) return "Choose its choice field and card title field";
  if (queryReference === null) return "Choose the data it shows";
  const separator = queryReference.indexOf(":");
  const module = (source.body.modules ?? []).find((candidate) => candidate.key === queryReference.slice(0, separator));
  if (module === undefined) return undefined;
  const query = module.queries.find((candidate) => candidate.key === queryReference.slice(separator + 1));
  const record = module.record_types.find((candidate) => candidate.key === query?.record_type);
  if (query === undefined || record === undefined) return "Its data is not a query of this application";
  const fieldId = (field: string) => identity(`${module.key}:${record.key}.${field}`);
  const choice = record.fields.find((field) => fieldId(field.key) === contract.choiceField);
  // A board's columns and moves come from the pipeline of its choice field.
  if (choice !== undefined && !record.pipelines.some((pipeline) => pipeline.stage_field === choice.key))
    return `${choice.label} has no pipeline yet. Create one in the Data tab, on ${record.plural_name}, ` +
      "to give the board its columns and the moves between them";
  const supported = boardBlockSourceIsSupported(
    {
      selectedFieldIds: (query.select.length === 0 ? record.fields.map((field) => field.key) : query.select).map(fieldId),
      groupByFieldIds: query.group_by.map(fieldId),
      aggregates: query.aggregates,
      relationshipHops: query.relationship_hops,
      pageSize: query.page_size,
    },
    record.fields.map((field) => ({ ...field, fieldId: fieldId(field.key) })),
    record.pipelines.map((pipeline) => ({ stageFieldId: fieldId(pipeline.stage_field) })),
    contract,
  );
  if (supported) return undefined;
  return `Its data, ${query.label ?? query.key}, must be grouped by ${choice?.label ?? "its choice field"} ` +
    "(a filterable choice field with 1 to 12 options) and select the card title and detail fields";
};
