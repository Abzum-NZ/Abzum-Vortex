import {
  checkQueryBindings,
  type QueryBindingControl,
  type QueryBindingField,
  type QueryBindingInput,
  type QueryBindingPageFacts,
  type QueryBindingPageParameter,
  type QueryBindingProblem,
} from "./query-binding-check";
import {
  PAGE_SUBJECT_PARAMETER,
  readPublishedParameter,
  readQueryBindings,
} from "./query-bindings";
import {
  fieldBindingValueType,
  queryInputValueType,
  type QueryBindingValueType,
} from "./query-binding-values";

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

/** The record types a compiled link input may name, from its `record_types` setting. */
const linkInputTypes = (settings: JsonObject): readonly string[] =>
  array(object(settings.record_types ?? {}).items ?? []).flatMap((item) => {
    const recordType = object(object(item).recordType ?? {});
    return recordType.state === "resolved" && typeof recordType.recordTypeId === "string"
      ? [recordType.recordTypeId]
      : [];
  });

/**
 * What one compiled page offers the bindings of its blocks: the subject parameter of a record page,
 * each control's published parameter typed by the control, and the subject record's fields.
 */
export const compiledPageBindingFacts = <Entry extends Placement>(
  page: JsonObject,
  placements: readonly (readonly [string, Entry])[],
  blockKeyOf: (placement: Entry) => string | undefined,
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
  const parameters: QueryBindingPageParameter[] =
    subjectTypeId === undefined
      ? []
      : [{ name: PAGE_SUBJECT_PARAMETER, type: { kind: "record", recordTypes: [subjectTypeId] } }];
  const controls: QueryBindingControl[] = [];
  for (const [placementId, placement] of placements) {
    const settings = object(placement.settings ?? {});
    const parameter = readPublishedParameter(settings as Settings);
    const blockKey = blockKeyOf(placement);
    let type: QueryBindingValueType | undefined;
    if (blockKey === "platform.form.link_input")
      type = { kind: "record", recordTypes: linkInputTypes(settings) };
    else if (blockKey === "platform.form.field_input") {
      const field = fieldById.get(String(object(settings.field ?? {}).fieldId ?? "").toLowerCase());
      type = field === undefined ? undefined : fieldFacts(field).type;
    } else if (blockKey === "platform.form.text_input" || blockKey === "platform.form.choice_input")
      type = { kind: "text" };
    else if (blockKey === "platform.form.date_input") type = { kind: "date" };
    else if (
      blockKey === "platform.display.table" &&
      object(object(settings.row_click).properties).mode !== undefined &&
      object(object(object(settings.row_click).properties).mode).value === "select"
    ) {
      const query = object(queries.get(String(object(placement.vortex).queryId)));
      const recordType = object(query.recordType);
      if (recordType.state === "resolved")
        type = { kind: "record", recordTypes: [String(recordType.recordTypeId)] };
    } else continue;
    const label = text(settings.label) ?? text(settings.name) ?? placementId;
    controls.push({
      placement: placementId,
      label,
      ...(parameter === undefined ? {} : { parameter }),
    });
    if (parameter !== undefined && type !== undefined)
      parameters.push({ name: parameter, type, control: placementId });
  }
  return {
    parameters,
    controls,
    recordFields: subject === undefined ? undefined : array(subject.fields).map(fieldFacts),
    // No compiled page holds a row's related records yet, so This row is refused everywhere.
    rowFields: undefined,
    recordTypeLabel: (id) => String(recordById.get(id.toLowerCase())?.singularLabel ?? id),
  };
};

/** The inputs of a compiled Module query, typed for the binding check. */
export const compiledQueryInputs = (query: JsonObject): readonly QueryBindingInput[] =>
  array(query.inputs ?? []).map((input) => ({
    key: String(input.key),
    label: String(input.label ?? input.key),
    required: input.required === true,
    type: queryInputValueType({
      type: String(input.type),
      recordTypes: array(input.recordTypes ?? []).flatMap((recordType) =>
        recordType.state === "resolved" ? [String(recordType.recordTypeId)] : [],
      ),
    }),
  }));

/** The binding problems of one compiled query-bound placement; a malformed item is one problem. */
export const compiledPlacementBindingProblems = (
  placement: Placement,
  blockName: string,
  query: JsonObject,
  facts: Omit<QueryBindingPageFacts, "blockLabel">,
): readonly QueryBindingProblem[] => {
  const settings = object(placement.settings ?? {}) as Settings;
  const read = readQueryBindings(settings);
  const blockLabel = text(object(settings).title) ?? blockName;
  if (read.kind === "malformed")
    return [{ sentence: `${blockLabel} has an input binding without its source.` }];
  return checkQueryBindings(read.bindings, compiledQueryInputs(query), { ...facts, blockLabel });
};
