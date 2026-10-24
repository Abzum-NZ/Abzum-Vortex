import {
  checkQueryBindings,
  pageBindingFacts,
  selectionControlSettingKey,
  type QueryBindingField,
  type QueryBindingInput,
  type QueryBindingPageFacts,
  type QueryBindingPlacement,
  type QueryBindingProblem,
} from "./query-binding-check";
import { readPublishedParameter, readQueryBindings } from "./query-bindings";
import { fieldBindingValueType, queryInputValueType } from "./query-binding-values";

/**
 * The binding facts of compiled content, shared by publication (over the compiled release) and the
 * page read (over the installed release): both hold the same compiled pages, placements, record
 * types and queries, so a parameter publication accepted is the parameter the page resolves.
 */
type JsonObject = Readonly<Record<string, unknown>>;
const object = (value: unknown): JsonObject => (value ?? {}) as JsonObject;
const array = (value: unknown): readonly JsonObject[] =>
  Array.isArray(value) ? (value as JsonObject[]) : [];

type Placement = Readonly<{ settings: unknown; vortex: unknown }>;

/** The page types whose address names one record of the page's record type. */
export const recordPageTypes: ReadonlySet<string> = new Set([
  "detail",
  "public",
  "form",
  "guided_form",
]);
type Settings = Parameters<typeof readQueryBindings>[0];

const text = (value: unknown): string | undefined => {
  const setting = object(value ?? {});
  return setting.kind === "text" && typeof setting.value === "string" && setting.value.trim() !== ""
    ? setting.value.trim()
    : undefined;
};

/** The facts of one compiled record field a binding may name, in record type identities. */
const fieldFacts = (field: JsonObject): QueryBindingField => {
  const settings = object(field.settings ?? {});
  const target = object(settings.target ?? {});
  return {
    field: String(field.fieldId),
    label: String(field.label),
    type: fieldBindingValueType({
      type: String(field.type),
      ...(typeof target.recordTypeId === "string" ? { linkTargets: [target.recordTypeId] } : {}),
      ...(typeof settings.resultType === "string" ? { resultType: settings.resultType } : {}),
    }),
  };
};

/** The fields of one compiled record type a binding may name, typed for the binding check. */
export const compiledRecordBindingFields = (record: unknown): readonly QueryBindingField[] =>
  array(object(record).fields).map(fieldFacts);

/** The record types a compiled link input may name, from its `record_types` setting. */
const linkInputTypes = (settings: JsonObject): readonly string[] =>
  array(object(settings.record_types ?? {}).items ?? []).flatMap((item) => {
    const recordType = object(object(item).recordType ?? {});
    return recordType.state === "resolved" && typeof recordType.recordTypeId === "string"
      ? [recordType.recordTypeId]
      : [];
  });

/**
 * What one compiled page offers the bindings of its blocks, through the one page facts builder
 * Studio also uses: its subject, its controls with what each publishes, and its subject's fields.
 */
export const compiledPageBindingFacts = <Entry extends Placement>(
  page: JsonObject,
  placements: readonly (readonly [string, Entry])[],
  blockOf: (placement: Entry) => Readonly<{ key: string; name: string }> | undefined,
  records: ReadonlyMap<string, unknown>,
  queries: ReadonlyMap<string, unknown>,
): Omit<QueryBindingPageFacts, "blockLabel"> => {
  const recordById = new Map(
    [...records].map(([id, record]) => [id.toLowerCase(), object(record)]),
  );
  const fieldById = new Map(
    [...records.values()].flatMap((record) =>
      array(object(record).fields).map(
        (field) => [String(field.fieldId).toLowerCase(), field] as const,
      ),
    ),
  );
  const recordTypeLabel = (id: string): string => {
    const label = recordById.get(id.toLowerCase())?.singularLabel;
    return typeof label === "string" ? label : "record";
  };
  // Only a record page is addressed by its subject; a list page's record type names no record.
  const recordType = object(page.recordType ?? {});
  const subjectTypeId =
    recordPageTypes.has(String(page.type)) &&
    recordType.state === "resolved" &&
    typeof recordType.recordTypeId === "string"
      ? recordType.recordTypeId
      : undefined;
  const subject =
    subjectTypeId === undefined ? undefined : recordById.get(subjectTypeId.toLowerCase());
  const directoryPersonTypeId = [...recordById.values()].find(
    (record) => object(record.systemProjection).protectedView === "organization_accounts",
  )?.recordTypeId;
  const directoryGroupTypeId = [...recordById.values()].find(
    (record) => object(record.systemProjection).protectedView === "groups",
  )?.recordTypeId;
  return pageBindingFacts({
    currentPersonRecordType:
      typeof directoryPersonTypeId === "string" ? directoryPersonTypeId : undefined,
    currentTeamRecordType:
      typeof directoryGroupTypeId === "string" ? directoryGroupTypeId : undefined,
    subject:
      subjectTypeId === undefined
        ? undefined
        : { recordType: subjectTypeId, label: recordTypeLabel(subjectTypeId) },
    placements: placements.map(([placementId, placement]): QueryBindingPlacement => {
      const settings = object(placement.settings ?? {});
      const block = blockOf(placement);
      const selectionKey = selectionControlSettingKey(block?.key);
      const field = fieldById.get(String(object(settings.field ?? {}).fieldId ?? "").toLowerCase());
      const rowClick = object(object(settings.row_click).properties);
      const query = object(queries.get(String(object(placement.vortex).queryId)));
      const queryRecordType = object(query.recordType);
      return {
        placement: placementId,
        blockKey: block?.key,
        label: text(settings.label) ?? text(settings.title),
        blockName: block?.name ?? "This block",
        parameter: readPublishedParameter(settings as Settings),
        selectionControl: selectionKey === undefined ? undefined : text(settings[selectionKey]),
        linkTargets: linkInputTypes(settings),
        fieldType: field === undefined ? undefined : fieldFacts(field).type,
        selectedRecordType:
          object(rowClick.mode).value === "select" && queryRecordType.state === "resolved"
            ? String(queryRecordType.recordTypeId)
            : undefined,
      };
    }),
    recordFields: subject === undefined ? undefined : array(subject.fields).map(fieldFacts),
    recordTypeLabel,
  });
};

/** The inputs of a compiled Module query, typed for the binding check. */
export const compiledQueryInputs = (query: JsonObject): readonly QueryBindingInput[] =>
  array(query.inputs ?? []).map((input) => ({
    key: String(input.key),
    label: String(input.label),
    required: input.required === true,
    ...(input.type === "text" && object(input.validation ?? {}).choices !== undefined
      ? {
          choices: array(object(input.validation).choices).map((choice) => ({
            value: String(choice.value),
            label: String(choice.label),
          })),
        }
      : {}),
    type: queryInputValueType({
      type: String(input.type),
      recordTypes: array(input.recordTypes ?? []).flatMap((recordType) =>
        recordType.state === "resolved" ? [String(recordType.recordTypeId)] : [],
      ),
    }),
  }));

/** The binding problems of one compiled query-bound placement. */
export const compiledPlacementBindingProblems = (
  placement: Placement,
  blockName: string,
  query: JsonObject,
  facts: Omit<QueryBindingPageFacts, "blockLabel">,
): readonly QueryBindingProblem[] => {
  const settings = object(placement.settings ?? {}) as Settings;
  const blockLabel = text(object(settings).title) ?? blockName;
  return checkQueryBindings(readQueryBindings(settings), compiledQueryInputs(query), {
    ...facts,
    blockLabel,
  });
};
