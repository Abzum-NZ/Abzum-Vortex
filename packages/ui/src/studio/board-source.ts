import {
  boardBlockSourceIsSupported,
  readBoardPlacementContract,
  type ApplicationSourceDocument,
  type BlockPropertyValueContract,
  type PlatformBlockRelease,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import { uniqueKey } from "./application-structure-common";
import { studioFieldFacts } from "./contextual-palette";

type PipelineStudioSetup = Extract<NonNullable<PlatformBlockRelease["studioSetup"]>, { kind: "pipeline" }>;

/** A declared pipeline selector offers every pipeline, including ones whose stage needs attention. */
export const studioBoardPipelines = (source: ApplicationSourceDocument, setup: PipelineStudioSetup) =>
  source.body.modules.flatMap((module) => module.record_types.flatMap((record) =>
    record.pipelines.map((pipeline) => {
      const stage = record.fields.find((field) => field.key === pipeline.stage_field);
      const title = record.fields.find((field) => field.key === record.title_field);
      const selectable = stage?.type === "choice" && stage.filterable && title !== undefined;
      return {
        reference: `${module.key}:${record.key}.${pipeline.stage_field}`,
        label: `${record.plural_name}: ${pipeline.name}`,
        titleField: title === undefined ? undefined : `${module.key}:${record.key}.${title.key}`,
        selectable,
        ...(selectable ? {} : { unavailableReason: setup.stageFilterError }),
        fields: record.fields.map((field) => ({ reference: `${module.key}:${record.key}.${field.key}`,
          label: field.label, type: field.type, ...studioFieldFacts(field) })),
      };
    })));

/** Writes an ordinary unfiltered grouped query, editable in Data like any other query. */
export const createStudioBoardQuery = (source: ApplicationSourceDocument,
  settings: Readonly<Record<string, SourceBlockPropertyValueContract>>, taken: ReadonlySet<string>,
  setup: PipelineStudioSetup): string | undefined => {
  const field = settings[setup.fieldProperty];
  if (field?.kind !== "field_reference") return undefined;
  const titleField = settings[setup.titleFieldProperty];
  if (titleField?.kind !== "field_reference") return undefined;
  const pipeline = studioBoardPipelines(source, setup).find((candidate) => candidate.reference === field.field);
  if (pipeline === undefined || !pipeline.selectable) return undefined;
  const [moduleKey, rest] = field.field.split(":");
  const [recordKey, stageKey] = rest!.split(".");
  const module = source.body.modules.find((candidate) => candidate.key === moduleKey)!;
  const record = module.record_types.find((candidate) => candidate.key === recordKey)!;
  const qualifiedFieldKey = (reference: string): string | undefined => {
    const prefix = `${module.key}:${record.key}.`;
    return reference.startsWith(prefix) ? reference.slice(prefix.length) : undefined;
  };
  const detailFields = settings.detail_fields?.kind === "list" ? settings.detail_fields.items.flatMap((item) => {
    if (item.kind !== "group") return [];
    const detail = item.properties.field;
    return detail?.kind === "field_reference" ? [detail.field] : [];
  }) : [];
  const requestedKeys = [field.field, titleField.field, ...detailFields].map(qualifiedFieldKey);
  if (requestedKeys.some((key) => key === undefined)) return undefined;
  const selected = [...new Set(requestedKeys.filter((key): key is string => key !== undefined))];
  const selectsExactly = (candidate: readonly string[]): boolean => candidate.length === selected.length &&
    selected.every((key) => candidate.includes(key));
  const existing = module.queries.find((query) => query.record_type === record.key && query.filter === null &&
    query.inputs.length === 0 && query.group_by.length === 1 && query.group_by[0] === stageKey &&
    query.relationship_hops === 0 && query.aggregates.length === 0 &&
    selectsExactly(query.select.length === 0 ? record.fields.map((candidate) => candidate.key) : query.select));
  if (existing !== undefined) return `${module.key}:${existing.key}`;
  if (module.queries.length >= 100) return undefined;
  const key = uniqueKey(`${record.key}_by_${stageKey}`, "", new Set(module.queries.map((query) => query.key)), 40);
  const id = uniqueKey(`qry_${key}`, "", taken, 160);
  module.queries.push({ id, key, label: pipeline.label, exposure: "private", record_type: record.key,
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
  setup: PipelineStudioSetup,
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
  if (contract === undefined) return "Choose its pipeline and card title field";
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
  if (choice !== undefined && !choice.filterable) return setup.stageFilterError;
  if (choice !== undefined && !record.pipelines.some((pipeline) => pipeline.stage_field === choice.key))
    return `${choice.label}: ${setup.fieldHasNoPipeline}`;
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
