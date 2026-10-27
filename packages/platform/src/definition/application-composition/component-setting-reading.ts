import { asRecord } from "../../catalogue/runtime-primitives";
import type {
  BlockPropertySchemaContract,
  ComponentSettingFailure,
  ComponentSettingValue,
} from "./block-property-schema";
import type { BlockPropertyValueContract } from "./block-property-values";
import { releaseSettingDeclarations } from "./placement-slots";

/*
 * Reading a placement's settings by their declarations, apart from the setting value contracts:
 * the shape of a settings object and the kind-tagged value of each plain compiled setting. A
 * renderer reads a composition that was checked where it was produced (publication, or Studio's
 * checking reader), so it reads here without loading those contracts.
 */

/**
 * The control an automatic field input renders, chosen from its referenced module field type by the
 * compiler. A field that has no compatible control here is refused at publication.
 */
export const fieldInputControlKeys = [
  "text",
  "rich_text",
  "number",
  "boolean",
  "date",
  "date_time",
  "choice",
  "several_choices",
  "link",
  "table",
  "attachment",
] as const;
export type FieldInputControlKey = (typeof fieldInputControlKeys)[number];

/**
 * Undeclared setting names that would carry markup, script, styling, data access or component
 * code. Any undeclared setting is refused; these are refused as unsafe content rather than as a
 * merely unknown property.
 */
const executableSettingKeys: ReadonlySet<string> = new Set([
  "class",
  "class_name",
  "classes",
  "code",
  "component",
  "component_code",
  "css",
  "dangerously_set_inner_html",
  "handler",
  "html",
  "inner_html",
  "jsx",
  "markup",
  "raw_html",
  "rpc",
  "script",
  "source_code",
  "sql",
  "style",
  "styles",
  "tsx",
]);

/** True when an undeclared setting name would carry executable or presentational code. */
export const isExecutableComponentSettingKey = (key: string): boolean =>
  executableSettingKeys.has(key) || /^on_[a-z]/.test(key);

/** A conditional setting is required and shown only for its selected sibling choice. */
export const componentSettingApplies = (
  declaration: BlockPropertySchemaContract,
  settings: Readonly<Record<string, ComponentSettingValue>>,
): boolean => {
  if (declaration.showWhen === undefined) return true;
  const selected = settings[declaration.showWhen.property];
  return selected?.kind === "choice" && declaration.showWhen.values.includes(selected.value);
};

/**
 * The plain form of one canonical setting value: the value without its kind, as a compiled item
 * carries it. A compiled item holds every setting in this form, exactly as a stored item does; only
 * its references are resolved to canonical identities.
 */
export const plainSettingValue = (value: BlockPropertyValueContract): unknown => {
  switch (value.kind) {
    case "asset_reference":
      return value.assetId;
    case "icon":
      return value.iconKey;
    case "field_reference":
      return value.fieldId;
    case "condition":
      return value.condition;
    case "relationship_reference":
      return value.relationshipId;
    case "action_reference":
      return value.actionKey;
    case "page_reference":
      return value.pageId;
    case "query_reference":
      return value.queryId;
    case "record_type_reference":
      return value.recordType;
    case "record_reference":
      return { recordType: value.recordType, recordId: value.recordId };
    case "group":
      return Object.fromEntries(
        Object.entries(value.properties).map(([key, nested]) => [key, plainSettingValue(nested)]),
      );
    case "list":
      return value.items.map(plainSettingValue);
    default:
      return value.value;
  }
};

/**
 * The kind-tagged candidate of one plain compiled value, built from the declaration it fills; the
 * closed value contract then judges it. Undefined when the plain value has the wrong shape.
 */
export const typedSettingCandidate = (
  value: unknown,
  declaration: BlockPropertySchemaContract,
): unknown => {
  switch (declaration.kind) {
    case "total_reference":
    case "text":
    case "number":
    case "boolean":
    case "choice":
    case "rich_text":
    case "url":
      return { kind: declaration.kind, value };
    case "asset_reference":
      return { kind: declaration.kind, assetId: value };
    case "icon":
      return { kind: declaration.kind, iconKey: value };
    case "field_reference":
      return { kind: declaration.kind, fieldId: value };
    case "condition":
      return { kind: declaration.kind, condition: value };
    case "relationship_reference":
      return { kind: declaration.kind, relationshipId: value };
    case "action_reference":
      return { kind: declaration.kind, actionKey: value };
    case "page_reference":
      return { kind: declaration.kind, pageId: value };
    case "query_reference":
      return { kind: declaration.kind, queryId: value };
    case "record_type_reference":
      return { kind: declaration.kind, recordType: value };
    case "record_reference": {
      const reference = asRecord(value);
      return reference === undefined ? undefined : { kind: declaration.kind, ...reference };
    }
    case "group": {
      const group = asRecord(value);
      if (group === undefined) return undefined;
      const declared = new Map(declaration.properties.map((property) => [property.key, property]));
      const properties: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(group)) {
        const property = declared.get(key);
        if (property === undefined) return undefined;
        properties[key] = typedSettingCandidate(nested, property);
      }
      return { kind: "group", properties };
    }
    case "list":
      return Array.isArray(value)
        ? {
            kind: "list",
            items: value.map((item: unknown) => typedSettingCandidate(item, declaration.item)),
          }
        : undefined;
  }
};

/** The undeclared keys of one settings object, as failures in key order. */
export const undeclaredComponentSettingFailures = (
  settings: Readonly<Record<string, ComponentSettingValue>>,
  declarations: readonly BlockPropertySchemaContract[],
): ComponentSettingFailure[] => {
  const declared = new Set(declarations.map((declaration) => declaration.key));
  return Object.keys(settings)
    .filter((key) => !declared.has(key))
    .map((key) => ({
      family: isExecutableComponentSettingKey(key) ? "unsafe_content" : "unknown_property",
      path: [key],
    }));
};

/** A required setting with no default that applies to these settings but is absent. */
export const componentSettingMissing = (
  declaration: BlockPropertySchemaContract,
  settings: Readonly<Record<string, ComponentSettingValue>>,
): boolean =>
  settings[declaration.key] === undefined &&
  declaration.required &&
  declaration.defaultValue === undefined &&
  componentSettingApplies(declaration, settings);

/**
 * The failures of one settings object's shape against its declarations, without judging any held
 * value: every undeclared key, then every missing required value.
 */
export const componentSettingShapeFailures = (
  settings: Readonly<Record<string, ComponentSettingValue>>,
  declarations: readonly BlockPropertySchemaContract[],
): ComponentSettingFailure[] => [
  ...undeclaredComponentSettingFailures(settings, declarations),
  ...declarations
    .filter((declaration) => componentSettingMissing(declaration, settings))
    .map((declaration): ComponentSettingFailure => ({
      family: "required_value",
      path: [declaration.key],
    })),
];

/**
 * The settings of a compiled item's props by the declaration of its block release: each property
 * and derived property the release declares, when the props hold it, typed by `type`. No other
 * prop is a setting: slots, Puck's context and host wrappers are never read. A held value `type`
 * cannot read fails loudly.
 */
export const compiledItemSettingsBy = (
  props: Readonly<Record<string, unknown>>,
  release: Parameters<typeof releaseSettingDeclarations>[0],
  type: (value: unknown, declaration: BlockPropertySchemaContract) => unknown,
): Record<string, BlockPropertyValueContract> => {
  const settings: Record<string, BlockPropertyValueContract> = {};
  for (const declaration of releaseSettingDeclarations(release)) {
    if (!Object.hasOwn(props, declaration.key)) continue;
    const value = props[declaration.key];
    // Puck writes `undefined` for an untouched field, which is absent.
    if (value === undefined) continue;
    const typed = type(value, declaration);
    if (typed === undefined)
      throw new TypeError(
        `Setting '${declaration.key}' of placement '${String(props.id)}' is not a ${declaration.kind} value`,
      );
    settings[declaration.key] = typed as BlockPropertyValueContract;
  }
  return settings;
};

/**
 * A compiled item's settings kind tagged from their declarations without judging the values: a
 * renderer reads a composition its producer checked. Studio, whose compositions change under the
 * editor, reads with `compiledItemSettings`, which checks every value.
 */
export const readCompiledItemSettings = (
  props: Readonly<Record<string, unknown>>,
  release: Parameters<typeof releaseSettingDeclarations>[0],
): Record<string, BlockPropertyValueContract> =>
  compiledItemSettingsBy(props, release, typedSettingCandidate);
