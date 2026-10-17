import {
  boardBlockSourceIsSupported,
  readBoardPlacementContract,
  type ApplicationSourceDocument,
  type BlockPropertyValueContract,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";

/** The release key of the Board block, whose query publication judges with `boardBlockSourceIsSupported`. */
export const boardBlockKey = "platform.display.board";

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
