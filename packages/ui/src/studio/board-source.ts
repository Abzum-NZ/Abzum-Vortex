import {
  boardBlockSourceIsSupported,
  readBoardPlacementContract,
  type ApplicationSourceDocument,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";

/** The release key of the Board block, whose query publication judges with `boardBlockSourceIsSupported`. */
export const boardBlockKey = "platform.display.board";

/**
 * Why a Board cannot read this query, judged by the same rule publication applies
 * (`boardBlockSourceIsSupported`), over the draft's own query and record type spelled as that rule
 * reads them: every field by its qualified reference. Undefined when the Board can read it. A query
 * of a Module the application only uses is judged at publication.
 */
export const studioBoardSourceProblem = (
  source: ApplicationSourceDocument,
  settings: Readonly<Record<string, SourceBlockPropertyValueContract>>,
  queryReference: string | null,
): string | undefined => {
  const contract = readBoardPlacementContract(settings);
  if (contract === undefined) return "Choose its choice field and card title field";
  if (queryReference === null) return "Choose the data it shows";
  const separator = queryReference.indexOf(":");
  const module = (source.body.modules ?? []).find((candidate) => candidate.key === queryReference.slice(0, separator));
  if (module === undefined) return undefined;
  const query = module.queries.find((candidate) => candidate.key === queryReference.slice(separator + 1));
  const record = module.record_types.find((candidate) => candidate.key === query?.record_type);
  if (query === undefined || record === undefined) return "Its data is not a query of this application";
  const reference = (field: string) => `${module.key}:${record.key}.${field}`;
  const supported = boardBlockSourceIsSupported(
    {
      selectedFieldIds: (query.select.length === 0 ? record.fields.map((field) => field.key) : query.select).map(reference),
      groupByFieldIds: query.group_by.map(reference),
      aggregates: query.aggregates,
      relationshipHops: query.relationship_hops,
      pageSize: query.page_size,
    },
    record.fields.map((field) => ({ ...field, fieldId: reference(field.key) })),
    contract,
  );
  if (supported) return undefined;
  const label = (reference: string) =>
    record.fields.find((field) => `${module.key}:${record.key}.${field.key}` === reference)?.label ?? "its choice field";
  return `Its data, ${query.label ?? query.key}, must be grouped by ${label(contract.choiceField)} (a choice field with 1 to 12 options) ` +
    "and select the card title and detail fields";
};
