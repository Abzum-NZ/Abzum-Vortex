import { z } from "zod";
import {
  blockPaletteGroupSchema,
  workflowValueTypeSchema,
  type BlockPaletteGroup,
} from "./catalogues";
import { labelSchema, safeHttpsUrlSchema } from "./common";
import {
  sourceAliasSchema,
  sourceQualifiedConditionSchema,
  sourceQualifiedFieldSchema,
  sourceQualifiedQueryReferenceSchema,
  sourceQualifiedRecordTypeSchema,
  sourceQualifiedRelationshipSchema,
} from "./definition-source-common";
import {
  componentSemanticEventKindSchema,
  type ComponentSemanticEventKind,
} from "./application-flow-bindings";
import { recordTypeReferenceSchema } from "./definitions";
import { conditionNodeSchema } from "./module-contracts";
import {
  blockIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  fieldIdSchema,
  fingerprintSchema,
  namespacedKeySchema,
  pageIdSchema,
  pipelineIdSchema,
  platformIdSchema,
  queryIdSchema,
  recordIdSchema,
  semanticVersionSchema,
  shellIdSchema,
} from "./identifiers";
import {
  richTextDocumentV2Schema,
  richTextElementKindV2Schema,
  type RichTextInlineV2,
} from "./rich-text";
import type { DefinitionRuleFailureFamily } from "./validation-errors";

export {
  richTextBlockV2Schema,
  richTextDocumentV2Schema,
  richTextElementKindV2Schema,
} from "./rich-text";

const iconKeySchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const nonNegativeFiniteSchema = z.number().finite().nonnegative();
const positiveFiniteSchema = z.number().finite().positive();

export type BlockPropertyValueV2Contract =
  | { kind: "text"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "choice"; value: string }
  | { kind: "rich_text"; value: z.infer<typeof richTextDocumentV2Schema> }
  | { kind: "url"; value: string }
  | { kind: "asset_reference"; assetId: z.infer<typeof platformIdSchema> }
  | { kind: "icon"; iconKey: string }
  | { kind: "theme_token"; tokenKey: string }
  | { kind: "field_reference"; fieldId: z.infer<typeof fieldIdSchema> }
  | {
      kind: "relationship_reference";
      relationshipId: z.infer<typeof containedComponentIdSchema>;
    }
  | { kind: "action_reference"; actionKey: z.infer<typeof namespacedKeySchema> }
  | { kind: "page_reference"; pageId: z.infer<typeof pageIdSchema> }
  | { kind: "query_reference"; queryId: z.infer<typeof queryIdSchema> }
  | { kind: "pipeline_reference"; pipelineId: z.infer<typeof pipelineIdSchema> }
  | { kind: "record_type_reference"; recordType: z.infer<typeof recordTypeReferenceSchema> }
  | {
      kind: "record_reference";
      recordType: z.infer<typeof recordTypeReferenceSchema>;
      recordId: z.infer<typeof recordIdSchema>;
    }
  | { kind: "group"; properties: Record<string, BlockPropertyValueV2Contract> }
  | { kind: "list"; items: BlockPropertyValueV2Contract[] };

/** Canonical V2 values are closed and kind-discriminated; there is no arbitrary JSON branch. */
export const blockPropertyValueV2Schema: z.ZodType<BlockPropertyValueV2Contract> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), value: z.string() }).strict(),
    z.object({ kind: z.literal("number"), value: z.number().finite() }).strict(),
    z.object({ kind: z.literal("boolean"), value: z.boolean() }).strict(),
    z.object({ kind: z.literal("choice"), value: builderKeySchema }).strict(),
    z.object({ kind: z.literal("rich_text"), value: richTextDocumentV2Schema }).strict(),
    z.object({ kind: z.literal("url"), value: safeHttpsUrlSchema }).strict(),
    z.object({ kind: z.literal("asset_reference"), assetId: platformIdSchema }).strict(),
    z.object({ kind: z.literal("icon"), iconKey: builderKeySchema }).strict(),
    z.object({ kind: z.literal("theme_token"), tokenKey: builderKeySchema }).strict(),
    z.object({ kind: z.literal("field_reference"), fieldId: fieldIdSchema }).strict(),
    z
      .object({
        kind: z.literal("relationship_reference"),
        relationshipId: containedComponentIdSchema,
      })
      .strict(),
    z.object({ kind: z.literal("action_reference"), actionKey: namespacedKeySchema }).strict(),
    z.object({ kind: z.literal("page_reference"), pageId: pageIdSchema }).strict(),
    z.object({ kind: z.literal("query_reference"), queryId: queryIdSchema }).strict(),
    z.object({ kind: z.literal("pipeline_reference"), pipelineId: pipelineIdSchema }).strict(),
    z
      .object({ kind: z.literal("record_type_reference"), recordType: recordTypeReferenceSchema })
      .strict(),
    z
      .object({
        kind: z.literal("record_reference"),
        recordType: recordTypeReferenceSchema,
        recordId: recordIdSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("group"),
        properties: z.record(builderKeySchema, blockPropertyValueV2Schema),
      })
      .strict(),
    z.object({ kind: z.literal("list"), items: z.array(blockPropertyValueV2Schema) }).strict(),
  ]),
);

export type SourceBlockPropertyValueV2Contract =
  | { kind: "text"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "choice"; value: string }
  | { kind: "rich_text"; value: z.infer<typeof richTextDocumentV2Schema> }
  | { kind: "url"; value: string }
  | { kind: "asset_reference"; asset_id: z.infer<typeof platformIdSchema> }
  | { kind: "icon"; icon_key: string }
  | { kind: "theme_token"; token: string }
  | { kind: "field_reference"; field: z.infer<typeof sourceQualifiedFieldSchema> }
  | {
      kind: "relationship_reference";
      relationship: z.infer<typeof sourceQualifiedRelationshipSchema>;
    }
  | { kind: "action_reference"; action: z.infer<typeof namespacedKeySchema> }
  | { kind: "page_reference"; page: z.infer<typeof builderKeySchema> }
  | { kind: "query_reference"; query: z.infer<typeof sourceQualifiedQueryReferenceSchema> }
  | { kind: "pipeline_reference"; pipeline: z.infer<typeof builderKeySchema> }
  | {
      kind: "record_type_reference";
      record_type: z.infer<typeof sourceQualifiedRecordTypeSchema>;
    }
  | { kind: "record_reference"; record_type: string; record_id: string }
  | { kind: "group"; properties: Record<string, SourceBlockPropertyValueV2Contract> }
  | { kind: "list"; items: SourceBlockPropertyValueV2Contract[] };

/** Authored V2 values retain portable aliases while preserving the same closed value kinds. */
export const sourceBlockPropertyValueV2Schema: z.ZodType<SourceBlockPropertyValueV2Contract> =
  z.lazy(() =>
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("text"), value: z.string() }).strict(),
      z.object({ kind: z.literal("number"), value: z.number().finite() }).strict(),
      z.object({ kind: z.literal("boolean"), value: z.boolean() }).strict(),
      z.object({ kind: z.literal("choice"), value: builderKeySchema }).strict(),
      z.object({ kind: z.literal("rich_text"), value: richTextDocumentV2Schema }).strict(),
      z.object({ kind: z.literal("url"), value: safeHttpsUrlSchema }).strict(),
      z.object({ kind: z.literal("asset_reference"), asset_id: platformIdSchema }).strict(),
      z.object({ kind: z.literal("icon"), icon_key: builderKeySchema }).strict(),
      z.object({ kind: z.literal("theme_token"), token: builderKeySchema }).strict(),
      z.object({ kind: z.literal("field_reference"), field: sourceQualifiedFieldSchema }).strict(),
      z
        .object({
          kind: z.literal("relationship_reference"),
          relationship: sourceQualifiedRelationshipSchema,
        })
        .strict(),
      z.object({ kind: z.literal("action_reference"), action: namespacedKeySchema }).strict(),
      z.object({ kind: z.literal("page_reference"), page: builderKeySchema }).strict(),
      z
        .object({ kind: z.literal("query_reference"), query: sourceQualifiedQueryReferenceSchema })
        .strict(),
      z.object({ kind: z.literal("pipeline_reference"), pipeline: builderKeySchema }).strict(),
      z
        .object({
          kind: z.literal("record_type_reference"),
          record_type: sourceQualifiedRecordTypeSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("record_reference"),
          record_type: sourceQualifiedRecordTypeSchema,
          record_id: z.uuid(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("group"),
          properties: z.record(builderKeySchema, sourceBlockPropertyValueV2Schema),
        })
        .strict(),
      z
        .object({ kind: z.literal("list"), items: z.array(sourceBlockPropertyValueV2Schema) })
        .strict(),
    ]),
  );

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
  "choice",
  "link",
] as const;
export type FieldInputControlKey = (typeof fieldInputControlKeys)[number];

type BlockPropertySchemaV2Base = {
  key: string;
  label: string;
  help?: string | undefined;
  required: boolean;
  defaultValue?: BlockPropertyValueV2Contract | undefined;
  /**
   * Present only on the `field_reference` property an automatic field input binds its record field
   * to: the compiler then derives that input's name, label, requirement, choices and control from
   * the referenced module field. Authored and canonical values of the release are unchanged.
   */
  derivesFieldInput?: boolean | undefined;
};

export type BlockPropertySchemaV2Contract =
  | (BlockPropertySchemaV2Base & { kind: "text"; minLength: number; maxLength: number })
  | (BlockPropertySchemaV2Base & {
      kind: "number";
      integer: boolean;
      minimum?: number | undefined;
      maximum?: number | undefined;
    })
  | (BlockPropertySchemaV2Base & { kind: "boolean" })
  | (BlockPropertySchemaV2Base & {
      kind: "choice";
      options: { key: string; label: string }[];
    })
  | (BlockPropertySchemaV2Base & {
      kind: "rich_text";
      allowedElements: z.infer<typeof richTextElementKindV2Schema>[];
    })
  | (BlockPropertySchemaV2Base & { kind: "url" | "asset_reference" | "icon" })
  | (BlockPropertySchemaV2Base & {
      kind: "theme_token";
      tokenKind: z.infer<typeof themeTokenKindV2Schema>;
    })
  | (BlockPropertySchemaV2Base & {
      kind:
        | "field_reference"
        | "relationship_reference"
        | "action_reference"
        | "page_reference"
        | "query_reference"
        | "pipeline_reference"
        | "record_type_reference"
        | "record_reference";
    })
  | (BlockPropertySchemaV2Base & {
      kind: "group";
      properties: BlockPropertySchemaV2Contract[];
    })
  | (BlockPropertySchemaV2Base & {
      kind: "list";
      minimumItems: number;
      maximumItems: number;
      item: BlockPropertySchemaV2Contract;
    });

const propertySchemaBase = {
  key: builderKeySchema,
  label: labelSchema,
  help: z.string().min(1).max(1_000).optional(),
  required: z.boolean(),
  defaultValue: blockPropertyValueV2Schema.optional(),
  /**
   * Present only on the `field_reference` property an automatic field input binds its record field
   * to: the compiler derives that input's name, label, requirement, choices and control from the
   * referenced module field. Authored and canonical values of the release are unchanged.
   */
  derivesFieldInput: z.boolean().optional(),
};

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

/**
 * Syntax that marks authored text as markup, script, styling or a data-access statement rather
 * than prose. Each pattern needs structural syntax, so ordinary sentences such as "Select a
 * department from the list" or "Delete from list" remain valid text.
 */
const unsafeSettingTextPatterns: readonly RegExp[] = Object.freeze([
  // Raw HTML, XML or JSX: an element, closing tag, comment or declaration opener.
  /<[/!?]?[a-z]/i,
  /&(?:lt|#0*60|#x0*3c);\s*[/!?]?[a-z]/i,
  // Script-bearing addresses and inline handlers.
  /\b(?:javascript|vbscript|livescript)\s*:/i,
  /\bdata\s*:\s*(?:text\/html|[a-z]+\/[a-z.+-]*script)/i,
  /\bon[a-z]+\s*=\s*["'`{]/i,
  // Script execution and JSX escape hatches.
  /\b(?:eval|setTimeout|setInterval)\(/,
  /\bnew Function\(/,
  /\b(?:document|window)\.(?:cookie|write|writeln|location|open|eval)\b/,
  /\([\w\s,]*\)\s*=>\s*\{/,
  /\bdangerouslySetInnerHTML\b/i,
  // Arbitrary CSS and class names.
  /\b(?:style|class|className)\s*=\s*["'{]/i,
  /@(?:import\s+(?:url\s*\(|["'])|media\s*(?:\(|screen\b|print\b)|font-face\s*\{|keyframes\s+[\w-]+\s*\{)/i,
  /:\s*expression\s*\(/i,
  /\{\s*[a-z-]+\s*:\s*[^;{}]+;/i,
  // SQL statements.
  /\bunion\s+(?:all\s+)?select\b/i,
  /'\s*(?:or|and)\s+(?:'[^']*'|\d+)\s*=\s*(?:'[^']*'|\d+)/i,
  /\bselect\s+(?:\*|[\w."]+(?:\s*,\s*[\w."]+)+)\s+from\s+[\w."]+/i,
  /\binsert\s+into\s+[\w."]+\s*(?:\([\w\s,."]+\)\s*)?(?:values\s*\(|select\b)/i,
  /\bupdate\s+[\w."]+\s+set\s+[\w."]+\s*=/i,
  /\bdelete\s+from\s+[\w."]+\s*(?:;|where\s+[\w."]+\s*(?:[=<>!]|\b(?:in|is|like)\b))/i,
  /\b(?:drop|truncate)\s+table\s+(?:if\s+exists\s+)?[\w."]+\s*(?:;|--|\bcascade\b|\brestrict\b)/i,
  /\balter\s+table\s+[\w."]+\s+(?:add|drop|alter|rename|enable|disable|owner)\b/i,
  /\bcreate\s+(?:or\s+replace\s+)?(?:table\s+[\w."]+\s*\(\s*[\w"]+\s+[\w"]+|(?:function|procedure)\s+[\w."]+\s*\([^)]*\)\s*(?:returns|language|as)\b|view\s+[\w."]+\s+as\s+select\b)/i,
  /\bexec(?:ute)?\s+(?:procedure\s+[\w."]+|immediate\s+["'])/i,
  /\bpg_(?:sleep|read_file|ls_dir|read_binary_file)\s*\(/i,
  // Remote procedure calls outside the governed operation model.
  /\/rpc\//i,
  /\.\s*rpc\s*\(/i,
  /\bjson-?rpc\b/i,
  /\bgrpcs?:\/\//i,
]);

/** True when authored text carries markup, script, styling or a data-access statement. */
export const isUnsafeComponentSettingText = (text: string): boolean =>
  unsafeSettingTextPatterns.some((pattern) => pattern.test(text));

type RichTextSettingDocument = z.infer<typeof richTextDocumentV2Schema>;

const richTextSettingViolations = (
  document: RichTextSettingDocument,
): Readonly<{ kinds: ReadonlySet<string>; unsafe: boolean }> => {
  const kinds = new Set<string>();
  let unsafe = false;
  const visitInline = (inline: RichTextInlineV2): void => {
    if (inline.kind === "text") {
      if (isUnsafeComponentSettingText(inline.text)) unsafe = true;
      return;
    }
    kinds.add(inline.kind);
    if (inline.kind === "link" && isUnsafeComponentSettingText(inline.address)) unsafe = true;
    for (const child of inline.children) visitInline(child);
  };
  for (const block of document.blocks) {
    kinds.add(block.kind);
    if (block.kind === "paragraph" || block.kind === "heading")
      for (const child of block.children) visitInline(child);
    else for (const item of block.items) for (const child of item) visitInline(child);
  }
  return { kinds, unsafe };
};

/** Setting-value or setting-key violation families the shared component-setting validator emits. */
export type ComponentSettingFailureFamily = Extract<
  DefinitionRuleFailureFamily,
  | "required_value"
  | "invalid_value"
  | "unsupported_choice"
  | "unknown_property"
  | "too_few_items"
  | "too_many_items"
  | "unsafe_content"
>;

export type ComponentSettingFailure = Readonly<{
  family: ComponentSettingFailureFamily;
  /** Key path from the settings object root, including list item indices. */
  path: readonly (string | number)[];
}>;

/** Any authored or canonical value a component setting may hold. */
export type ComponentSettingValue =
  | BlockPropertyValueV2Contract
  | SourceBlockPropertyValueV2Contract;

/**
 * The one component-setting validator: it judges a supplied setting value against its exact
 * declaration, including unsafe text, so the designer can never accept what publishing rejects.
 * Authored and canonical values share the same kind vocabulary, so both forms use this function.
 */
export const validateComponentSettingValue = (
  value: ComponentSettingValue,
  declaration: BlockPropertySchemaV2Contract,
  path: readonly (string | number)[] = [],
): ComponentSettingFailure[] => {
  const failures: ComponentSettingFailure[] = [];
  const report = (family: ComponentSettingFailureFamily): void => {
    failures.push({ family, path });
  };
  if (value.kind !== declaration.kind) {
    report("invalid_value");
    return failures;
  }
  switch (declaration.kind) {
    case "text": {
      const text = (value as { value: string }).value;
      if (text.length < declaration.minLength || text.length > declaration.maxLength)
        report("invalid_value");
      if (isUnsafeComponentSettingText(text)) report("unsafe_content");
      break;
    }
    case "number": {
      const number = (value as { value: number }).value;
      if (
        (declaration.integer && !Number.isInteger(number)) ||
        (declaration.minimum !== undefined && number < declaration.minimum) ||
        (declaration.maximum !== undefined && number > declaration.maximum)
      )
        report("invalid_value");
      break;
    }
    case "choice": {
      const choice = (value as { value: string }).value;
      if (!declaration.options.some((option) => option.key === choice))
        report("unsupported_choice");
      break;
    }
    case "rich_text": {
      const document = (value as { value: RichTextSettingDocument }).value;
      const allowed = new Set<string>(declaration.allowedElements);
      const used = richTextSettingViolations(document);
      if ([...used.kinds].some((kind) => !allowed.has(kind))) report("unsupported_choice");
      if (used.unsafe) report("unsafe_content");
      break;
    }
    case "url": {
      if (isUnsafeComponentSettingText((value as { value: string }).value))
        report("unsafe_content");
      break;
    }
    case "group": {
      const properties = (value as { properties: Record<string, ComponentSettingValue> })
        .properties;
      const declared = new Set(declaration.properties.map((property) => property.key));
      for (const key of Object.keys(properties))
        if (!declared.has(key))
          failures.push({
            family: isExecutableComponentSettingKey(key) ? "unsafe_content" : "unknown_property",
            path: [...path, key],
          });
      for (const property of declaration.properties) {
        const nested = properties[property.key];
        if (nested === undefined) {
          if (property.required && property.defaultValue === undefined)
            failures.push({ family: "required_value", path: [...path, property.key] });
        } else {
          failures.push(
            ...validateComponentSettingValue(nested, property, [...path, property.key]),
          );
        }
      }
      break;
    }
    case "list": {
      const items = (value as { items: ComponentSettingValue[] }).items;
      if (items.length < declaration.minimumItems) report("too_few_items");
      if (items.length > declaration.maximumItems) report("too_many_items");
      items.forEach((item, index) => {
        failures.push(...validateComponentSettingValue(item, declaration.item, [...path, index]));
      });
      break;
    }
    default:
      break;
  }
  return failures;
};

/**
 * Validates one settings object against its declarations: every undeclared key, every supplied
 * value and every missing required value. Returns all failures with their setting key path.
 */
export const validateComponentSettings = (
  settings: Readonly<Record<string, ComponentSettingValue>>,
  declarations: readonly BlockPropertySchemaV2Contract[],
): ComponentSettingFailure[] => {
  const failures: ComponentSettingFailure[] = [];
  const byKey = new Set(declarations.map((declaration) => declaration.key));
  for (const key of Object.keys(settings))
    if (!byKey.has(key))
      failures.push({
        family: isExecutableComponentSettingKey(key) ? "unsafe_content" : "unknown_property",
        path: [key],
      });
  for (const declaration of declarations) {
    const value = settings[declaration.key];
    if (value !== undefined)
      failures.push(...validateComponentSettingValue(value, declaration, [declaration.key]));
    else if (declaration.required && declaration.defaultValue === undefined)
      failures.push({ family: "required_value", path: [declaration.key] });
  }
  return failures;
};

export const recordsDisplayFormats = [
  "automatic",
  "text",
  "number",
  "currency",
  "percent",
  "date",
  "date_time",
  "boolean",
] as const;
export type RecordsDisplayFormat = (typeof recordsDisplayFormats)[number];

export const recordsTableColumnWidths = ["auto", "narrow", "medium", "wide"] as const;
export const recordsTableColumnAlignments = ["start", "center", "end"] as const;
/** Low priority columns hide first on small screens; an essential column never hides. */
export const recordsTableColumnPriorities = ["essential", "high", "medium", "low"] as const;
export const recordsTableSelectionModes = ["none", "single", "multiple"] as const;

/** The record action kinds a configured row or bulk action may require of the viewer. */
export const recordsTableActionCapabilities = ["update", "delete", "restore"] as const;
export type RecordsTableActionCapability = (typeof recordsTableActionCapabilities)[number];

/**
 * One declared Records table column. `field` is the authored qualified field when read from a
 * source document and the canonical field identity when read from compiled settings.
 */
export type RecordsTableColumnContract = Readonly<{
  field: string;
  label?: string;
  format: RecordsDisplayFormat;
  width: (typeof recordsTableColumnWidths)[number];
  alignment: (typeof recordsTableColumnAlignments)[number];
  priority: (typeof recordsTableColumnPriorities)[number];
}>;

export type RecordsTableParameterContract = Readonly<{
  input: string;
  source: "fixed" | "page";
  fixedValue?: string;
  pageParameter?: string;
}>;

/** Authored messages a Records table or Record detail shows in place of its fixed neutral text. */
export type RecordsDisplayMessages = Readonly<{
  empty?: string;
  refused?: string;
  error?: string;
}>;

/**
 * One named row action or bulk action. `eventId` is the stable identity of the flow binding the
 * command runs; it is unique across one placement's declared behaviours, so a click reaches
 * exactly one flow. `capability`, when declared, names the record action the command needs: the
 * renderer hides it for a row whose per-row capabilities do not include that kind. A command that
 * declares no capability (an open, read or custom command) stays shown, and the server still
 * re-checks every action it runs.
 */
export type RecordsTableActionContract = Readonly<{
  eventId: string;
  label: string;
  capability?: RecordsTableActionCapability;
}>;

/** A row click held as a binding to a flow; the bound flow decides what opening the row does. */
export type RecordsTableRowClickContract = Readonly<{
  eventId: string;
}>;

/** Inline edit of permitted fields, with one commit binding shared by those fields. */
export type RecordsTableInlineEditContract = Readonly<{
  eventId: string;
  fields: readonly string[];
}>;

/** The configured row behaviours of one Records table placement. */
export type RecordsTableRowBehaviourContract = Readonly<{
  rowClick?: RecordsTableRowClickContract;
  rowActions: readonly RecordsTableActionContract[];
  bulkActions: readonly RecordsTableActionContract[];
  inlineEdit?: RecordsTableInlineEditContract;
}>;

/**
 * The data contract a Records table placement declares in its settings (decision 5). The data
 * source is the placement's own bound query; every field here must be a field that query allows.
 */
export type RecordsTableContract = Readonly<{
  columns: readonly RecordsTableColumnContract[];
  defaultSort?: Readonly<{ field: string; direction: "ascending" | "descending" }>;
  sortableFields: readonly string[];
  filterableFields: readonly string[];
  search: boolean;
  savedViews: boolean;
  pageSize: number;
  selectionMode: (typeof recordsTableSelectionModes)[number];
  parameters: readonly RecordsTableParameterContract[];
  messages: RecordsDisplayMessages;
  /** Configured row behaviours; empty for a placement that declares none. */
  rowBehaviours: RecordsTableRowBehaviourContract;
}>;

export type RecordDetailFieldContract = Readonly<{
  field: string;
  label?: string;
  format: RecordsDisplayFormat;
}>;

/** The declared list of detail fields a Record detail placement shows. */
export type RecordDetailContract = Readonly<{
  fields: readonly RecordDetailFieldContract[];
  messages: RecordsDisplayMessages;
}>;

type SettingsRecord = Readonly<Record<string, ComponentSettingValue>>;

const settingGroup = (value: ComponentSettingValue | undefined): SettingsRecord | undefined =>
  value?.kind === "group" ? value.properties : undefined;
const settingItems = (
  value: ComponentSettingValue | undefined,
): readonly ComponentSettingValue[] | undefined =>
  value?.kind === "list" ? value.items : undefined;
const settingText = (value: ComponentSettingValue | undefined): string | undefined =>
  value?.kind === "text" && value.value.trim().length > 0 ? value.value.trim() : undefined;
const settingChoice = <Choice extends string>(
  value: ComponentSettingValue | undefined,
  allowed: readonly Choice[],
  fallback: Choice,
): Choice =>
  value?.kind === "choice" && (allowed as readonly string[]).includes(value.value)
    ? (value.value as Choice)
    : fallback;
const settingField = (value: ComponentSettingValue | undefined): string | undefined =>
  value?.kind !== "field_reference"
    ? undefined
    : "fieldId" in value
      ? String(value.fieldId)
      : String(value.field);
const settingFlag = (value: ComponentSettingValue | undefined): boolean =>
  value?.kind === "boolean" && value.value;

/** A choice setting read only when it names one of the allowed values; otherwise absent. */
const settingOptionalChoice = <Choice extends string>(
  value: ComponentSettingValue | undefined,
  allowed: readonly Choice[],
): Choice | undefined =>
  value?.kind === "choice" && (allowed as readonly string[]).includes(value.value)
    ? (value.value as Choice)
    : undefined;

const displayMessages = (settings: SettingsRecord): RecordsDisplayMessages => {
  const empty = settingText(settings["empty_message"]);
  const refused = settingText(settings["refused_message"]);
  const error = settingText(settings["error_message"]);
  return {
    ...(empty === undefined ? {} : { empty }),
    ...(refused === undefined ? {} : { refused }),
    ...(error === undefined ? {} : { error }),
  };
};

const fieldList = (value: ComponentSettingValue | undefined): string[] =>
  (settingItems(value) ?? []).flatMap((item) => settingField(item) ?? []);

const settingEventId = (value: ComponentSettingValue | undefined): string | undefined =>
  settingText(value);

/** Reads one declared row-action or bulk-action list, keeping only entries with both parts. */
const readRowActionList = (
  value: ComponentSettingValue | undefined,
): RecordsTableActionContract[] =>
  (settingItems(value) ?? []).flatMap((item): RecordsTableActionContract[] => {
    const action = settingGroup(item);
    if (action === undefined) return [];
    const eventId = settingEventId(action["event_id"]);
    const label = settingText(action["label"]);
    if (eventId === undefined || label === undefined) return [];
    const capability = settingOptionalChoice(
      action["capability"],
      recordsTableActionCapabilities,
    );
    return [{ eventId, label, ...(capability === undefined ? {} : { capability }) }];
  });

/**
 * Reads the configured row behaviours from settings that already passed the shared validator. A
 * behaviour appears only when it carries the event identity that names its flow binding, so a
 * partially authored setting never invents a control.
 */
const readRowBehaviours = (settings: SettingsRecord): RecordsTableRowBehaviourContract => {
  const click = settingGroup(settings["row_click"]);
  const clickEventId = click === undefined ? undefined : settingEventId(click["event_id"]);
  const inline = settingGroup(settings["inline_edit"]);
  const inlineEventId = inline === undefined ? undefined : settingEventId(inline["event_id"]);
  const inlineFields = inline === undefined ? [] : fieldList(inline["fields"]);
  return {
    ...(clickEventId === undefined ? {} : { rowClick: { eventId: clickEventId } }),
    rowActions: readRowActionList(settings["row_actions"]),
    bulkActions: readRowActionList(settings["bulk_actions"]),
    ...(inlineEventId === undefined || inlineFields.length === 0
      ? {}
      : { inlineEdit: { eventId: inlineEventId, fields: inlineFields } }),
  };
};

/**
 * Reads a Records table placement's declared data contract from its settings, applying the
 * declared defaults. Returns undefined for a release that declares no `columns` setting, so the
 * earlier table releases keep their exact behaviour. It reads settings that already passed the
 * shared setting validator and never widens what a release declares; the same reader serves the
 * publication rule, the server query request and the renderer.
 */
export const readRecordsTableContract = (
  settings: SettingsRecord,
): RecordsTableContract | undefined => {
  const columnItems = settingItems(settings["columns"]);
  if (columnItems === undefined) return undefined;
  const columns = columnItems.flatMap((item): RecordsTableColumnContract[] => {
    const column = settingGroup(item);
    const field = column === undefined ? undefined : settingField(column["field"]);
    if (column === undefined || field === undefined) return [];
    const label = settingText(column["label"]);
    return [
      {
        field,
        ...(label === undefined ? {} : { label }),
        format: settingChoice(column["format"], recordsDisplayFormats, "automatic"),
        width: settingChoice(column["width"], recordsTableColumnWidths, "auto"),
        alignment: settingChoice(column["alignment"], recordsTableColumnAlignments, "start"),
        priority: settingChoice(column["priority"], recordsTableColumnPriorities, "medium"),
      },
    ];
  });
  const sort = settingGroup(settings["default_sort"]);
  const sortField = sort === undefined ? undefined : settingField(sort["field"]);
  const pageSize = settings["page_size"];
  const parameters = (settingItems(settings["query_parameters"]) ?? []).flatMap(
    (item): RecordsTableParameterContract[] => {
      const parameter = settingGroup(item);
      const input = parameter === undefined ? undefined : settingText(parameter["input"]);
      if (parameter === undefined || input === undefined) return [];
      const fixed = parameter["fixed_value"];
      const pageParameter = settingText(parameter["page_parameter"]);
      return [
        {
          input,
          source: settingChoice(parameter["source"], ["fixed", "page"] as const, "fixed"),
          ...(fixed?.kind === "text" ? { fixedValue: fixed.value } : {}),
          ...(pageParameter === undefined ? {} : { pageParameter }),
        },
      ];
    },
  );
  const direction = sort?.["direction"];
  return {
    columns,
    ...(sortField === undefined
      ? {}
      : {
          defaultSort: {
            field: sortField,
            direction:
              direction?.kind === "choice" && direction.value === "descending"
                ? "descending"
                : "ascending",
          },
        }),
    sortableFields: fieldList(settings["sortable_fields"]),
    filterableFields: fieldList(settings["filterable_fields"]),
    search: settingFlag(settings["search"]),
    savedViews: settingFlag(settings["saved_views"]),
    pageSize: pageSize?.kind === "number" ? pageSize.value : 25,
    selectionMode: settingChoice(settings["selection_mode"], recordsTableSelectionModes, "none"),
    parameters,
    messages: displayMessages(settings),
    rowBehaviours: readRowBehaviours(settings),
  };
};

/** Reads a Record detail placement's declared detail fields; undefined for earlier releases. */
export const readRecordDetailContract = (
  settings: SettingsRecord,
): RecordDetailContract | undefined => {
  const items = settingItems(settings["detail_fields"]);
  if (items === undefined) return undefined;
  const fields = items.flatMap((item): RecordDetailFieldContract[] => {
    const entry = settingGroup(item);
    const field = entry === undefined ? undefined : settingField(entry["field"]);
    if (entry === undefined || field === undefined) return [];
    const label = settingText(entry["label"]);
    return [
      {
        field,
        ...(label === undefined ? {} : { label }),
        format: settingChoice(entry["format"], recordsDisplayFormats, "automatic"),
      },
    ];
  });
  return { fields, messages: displayMessages(settings) };
};

/** Kinds naming application-scoped authority, which a platform-owned default cannot choose. */
const authorityReferenceKinds: ReadonlySet<string> = new Set([
  "field_reference",
  "relationship_reference",
  "action_reference",
  "page_reference",
  "query_reference",
  "pipeline_reference",
  "record_type_reference",
  "record_reference",
]);

/**
 * A platform-owned default must pass the shared setting validator and name no application-scoped
 * authority reference. Compilation copies a declared default verbatim without filling nested
 * defaults, so a grouped default must also spell every nested setting that is required or
 * declares its own default.
 */
const defaultMatchesProperty = (schema: BlockPropertySchemaV2Contract): boolean => {
  const value = schema.defaultValue;
  if (value === undefined) return true;
  const complete = (
    nested: BlockPropertyValueV2Contract,
    declaration: BlockPropertySchemaV2Contract,
  ): boolean => {
    if (authorityReferenceKinds.has(nested.kind)) return false;
    if (nested.kind === "group" && declaration.kind === "group")
      return declaration.properties.every((property) => {
        const child = nested.properties[property.key];
        return child === undefined
          ? !property.required && property.defaultValue === undefined
          : complete(child, property);
      });
    if (nested.kind === "list" && declaration.kind === "list")
      return nested.items.every((item) => complete(item, declaration.item));
    return true;
  };
  return validateComponentSettingValue(value, schema).length === 0 && complete(value, schema);
};

/** Recursive platform-owned property declaration, including only closed safe value kinds. */
export const blockPropertySchemaV2Schema: z.ZodType<BlockPropertySchemaV2Contract> = z.lazy(() =>
  z
    .discriminatedUnion("kind", [
      z
        .object({
          ...propertySchemaBase,
          kind: z.literal("text"),
          minLength: z.number().int().nonnegative(),
          maxLength: z.number().int().positive(),
        })
        .strict()
        .refine((value) => value.maxLength >= value.minLength, {
          path: ["maxLength"],
          message: "Maximum text length cannot be shorter than minimum length",
        }),
      z
        .object({
          ...propertySchemaBase,
          kind: z.literal("number"),
          integer: z.boolean(),
          minimum: z.number().finite().optional(),
          maximum: z.number().finite().optional(),
        })
        .strict()
        .refine(
          (value) =>
            value.minimum === undefined ||
            value.maximum === undefined ||
            value.maximum >= value.minimum,
          { path: ["maximum"], message: "Maximum number cannot be less than minimum" },
        ),
      z.object({ ...propertySchemaBase, kind: z.literal("boolean") }).strict(),
      z
        .object({
          ...propertySchemaBase,
          kind: z.literal("choice"),
          options: z.array(z.object({ key: builderKeySchema, label: labelSchema }).strict()).min(1),
        })
        .strict()
        .refine(
          (value) =>
            new Set(value.options.map((option) => option.key)).size === value.options.length,
          { path: ["options"], message: "Choice keys must be unique" },
        ),
      z
        .object({
          ...propertySchemaBase,
          kind: z.literal("rich_text"),
          allowedElements: z.array(richTextElementKindV2Schema).min(1),
        })
        .strict()
        .refine((value) => new Set(value.allowedElements).size === value.allowedElements.length, {
          path: ["allowedElements"],
          message: "Allowed rich-text elements must be unique",
        }),
      z.object({ ...propertySchemaBase, kind: z.literal("url") }).strict(),
      z.object({ ...propertySchemaBase, kind: z.literal("asset_reference") }).strict(),
      z.object({ ...propertySchemaBase, kind: z.literal("icon") }).strict(),
      z
        .object({
          ...propertySchemaBase,
          kind: z.literal("theme_token"),
          tokenKind: z.enum([
            "color_pair",
            "typography",
            "spacing",
            "corners",
            "border",
            "elevation",
            "focus",
            "asset",
            "density",
          ]),
        })
        .strict(),
      z
        .object({
          ...propertySchemaBase,
          kind: z.enum([
            "field_reference",
            "relationship_reference",
            "action_reference",
            "page_reference",
            "query_reference",
            "pipeline_reference",
            "record_type_reference",
            "record_reference",
          ]),
        })
        .strict(),
      z
        .object({
          ...propertySchemaBase,
          kind: z.literal("group"),
          properties: z.array(blockPropertySchemaV2Schema),
        })
        .strict()
        .refine(
          (value) =>
            new Set(value.properties.map((property) => property.key)).size ===
            value.properties.length,
          { path: ["properties"], message: "Grouped property keys must be unique" },
        ),
      z
        .object({
          ...propertySchemaBase,
          kind: z.literal("list"),
          minimumItems: z.number().int().nonnegative(),
          maximumItems: z.number().int().positive(),
          item: blockPropertySchemaV2Schema,
        })
        .strict()
        .refine((value) => value.maximumItems >= value.minimumItems, {
          path: ["maximumItems"],
          message: "Maximum list length cannot be shorter than minimum length",
        }),
    ])
    .superRefine((value, context) => {
      if (!defaultMatchesProperty(value))
        context.addIssue({
          code: "custom",
          path: ["defaultValue"],
          message: "Default value must satisfy its declared property schema",
        });
      if (value.derivesFieldInput === true && value.kind !== "field_reference")
        context.addIssue({
          code: "custom",
          path: ["derivesFieldInput"],
          message: "Only a field reference can derive an automatic field input",
        });
    }),
);

/**
 * The one `field_reference` property of an automatic field input, or undefined for every other
 * release. The compiler reads this declaration to derive the input's name, label, requirement,
 * choices and control from the referenced module field.
 */
export const findFieldInputBinding = (
  properties: readonly BlockPropertySchemaV2Contract[],
): BlockPropertySchemaV2Contract | undefined =>
  properties.find(
    (property) => property.kind === "field_reference" && property.derivesFieldInput === true,
  );

export const blockSlotDeclarationV2Schema = z
  .object({
    key: builderKeySchema,
    label: labelSchema,
    required: z.boolean(),
    allowedChildCategories: z.array(blockPaletteGroupSchema).min(1),
    /**
     * Present on a repeatable slot. The release then owns one child slot per item of the list
     * property named by `items`, each keyed by the item's stable identity read from that item's
     * text property named by `identity`. Absent on a fixed slot, whose `key` is its one slot key.
     */
    repeats: z
      .object({ items: builderKeySchema, identity: builderKeySchema })
      .strict()
      .optional(),
  })
  .strict();

/**
 * The exact placement slot key one repeatable item owns: `${family}_${identity}`. The family is
 * the repeatable slot declaration's key, so every slot the release declares stays a valid builder
 * key and two repeatable slot families on one release never collide.
 */
export const repeatableSlotKeyV2 = (family: string, identity: string): string =>
  `${family}_${identity}`;

/**
 * The stable item identities one repeatable slot declaration owns, read from a placement's
 * settings. An absent or wrong-kind list owns none. Every item of the list contributes exactly
 * one identity, returned verbatim in item order and including duplicates: an item that is not a
 * group or whose identity is not text contributes the empty identity. Callers therefore judge
 * every item with `isRepeatableSlotIdentityV2` and refuse a duplicate, rather than silently
 * dropping a malformed item or collapsing two items onto one slot.
 */
export const repeatableSlotItemIdentitiesV2 = (
  declaration: Readonly<{
    key: string;
    repeats?: Readonly<{ items: string; identity: string }> | undefined;
  }>,
  settings: Readonly<Record<string, ComponentSettingValue>>,
): readonly string[] => {
  const repeats = declaration.repeats;
  if (repeats === undefined) return [];
  const list = settings[repeats.items];
  if (list?.kind !== "list") return [];
  const identities: string[] = [];
  for (const item of list.items) {
    const identity = item.kind === "group" ? item.properties[repeats.identity] : undefined;
    identities.push(identity?.kind === "text" ? identity.value : "");
  }
  return identities;
};

/**
 * Whether one repeatable item identity is admissible: the identity itself and the slot key it
 * names under `family` must both be builder keys, so an identity never needs trimming or escaping
 * and the renderer, designer and publication all key the item's slot identically.
 */
export const isRepeatableSlotIdentityV2 = (family: string, identity: string): boolean =>
  builderKeySchema.safeParse(identity).success &&
  builderKeySchema.safeParse(repeatableSlotKeyV2(family, identity)).success;

const blockCapabilitiesV2Base = {
  responsiveVisibility: z.boolean(),
  responsiveOrder: z.boolean(),
  gridWidth: z.boolean(),
  height: z.enum(["content", "content_or_bounded"]),
  publicSurface: z.enum(["refused", "allowed"]),
};

const blockCapabilitiesV2Schema = z.discriminatedUnion("accessibleName", [
  z.object({ ...blockCapabilitiesV2Base, accessibleName: z.literal("not_applicable") }).strict(),
  z
    .object({
      ...blockCapabilitiesV2Base,
      accessibleName: z.enum(["required", "optional"]),
      accessibleNamePropertyPath: z.array(builderKeySchema).min(1),
    })
    .strict(),
]);

/**
 * State operations a flow may apply to a placed component. A release lists exactly the
 * operations it supports; none is implied by its palette group or renderer.
 */
export const componentStateOperationKindSchema = z.enum([
  "set_value",
  "reset",
  "select_tab",
  "open",
  "close",
]);

/**
 * The owner of a custom component release: the exact application or module release that bundles
 * it. A custom component belongs to exactly one owning release; only that application, or an
 * application that binds the owning module, may place it (application packages appendix,
 * "Custom components").
 */
export const customComponentOwnerV2Schema = z
  .object({
    kind: z.enum(["application", "module"]),
    definitionKey: namespacedKeySchema,
    releaseVersion: semanticVersionSchema,
  })
  .strict();

/** One typed value a custom component event carries. A payload field always declares a type. */
export const customComponentEventPayloadFieldV2Schema = z
  .object({
    key: builderKeySchema,
    label: labelSchema,
    type: workflowValueTypeSchema,
    required: z.boolean(),
  })
  .strict();

/**
 * One declared custom component event. An event carries a typed payload; an undeclared or untyped
 * payload field is refused, because the renderer validates every incoming message against this
 * declaration and drops anything else (it never trusts the component's origin).
 */
export const customComponentEventV2Schema = z
  .object({
    key: builderKeySchema,
    label: labelSchema,
    payload: z.array(customComponentEventPayloadFieldV2Schema).max(50),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.payload.map((field) => field.key)).size !== value.payload.length)
      context.addIssue({
        code: "custom",
        path: ["payload"],
        message: "Event payload field keys must be unique",
      });
  });

/**
 * The typed data contract a custom component reads: the values the renderer may send it, each
 * with a declared value type. Every value is treated as disclosed to the package's publisher, so
 * the contract is closed and typed rather than free-form.
 */
export const customComponentDataContractV2Schema = z
  .object({
    values: z
      .array(
        z
          .object({
            key: builderKeySchema,
            label: labelSchema,
            type: workflowValueTypeSchema,
            required: z.boolean(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.values.map((entry) => entry.key)).size !== value.values.length)
      context.addIssue({
        code: "custom",
        path: ["values"],
        message: "Data-contract value keys must be unique",
      });
  });

/** A relative module entry file inside the bundle: no scheme, absolute path, dot step or escape. */
const customComponentEntryFileSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.m?js$/, "Use a relative JavaScript module path")
  .refine(
    (value) => value.split("/").every((segment) => !/^\.+$/.test(segment)),
    "Use a relative path without dot or parent steps",
  );

/**
 * One external host the sandboxed frame may reach: a bare lowercase DNS name with at least two
 * labels, never a wildcard, a scheme or URL (so never a `data:` or `javascript:` source), a port,
 * an IP literal or a single-label name such as `localhost`.
 */
const customComponentHostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    "Use a bare lowercase host name",
  );

/**
 * The bundle manifest of a custom component: the Subresource Integrity digest the bootstrap
 * document verifies, the relative entry file it loads, and the external hosts the sandboxed frame
 * may reach. The digest is the release's immutable content address (application packages
 * appendix, "Custom components").
 */
export const customComponentBundleV2Schema = z
  .object({
    digest: z
      .string()
      .regex(/^sha384-[A-Za-z0-9+/]{64}$/, "Use a base64 SHA-384 Subresource Integrity digest"),
    entryFile: customComponentEntryFileSchema,
    allowedHosts: z.array(customComponentHostSchema).max(50),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.allowedHosts).size !== value.allowedHosts.length)
      context.addIssue({
        code: "custom",
        path: ["allowedHosts"],
        message: "Allowed hosts must be unique",
      });
  });

/**
 * The custom-component-specific part of a release: its owning release, its typed declared events,
 * its typed data contract, the accessible text alternative the host renders and its bundle
 * manifest. The release's own `properties`, `capabilities.accessibleName` and
 * `supportedStateOperations` carry the rest of the component contract.
 */
export const customComponentReleaseV2Schema = z
  .object({
    owner: customComponentOwnerV2Schema,
    events: z.array(customComponentEventV2Schema).max(50),
    dataContract: customComponentDataContractV2Schema,
    textAlternative: labelSchema,
    bundle: customComponentBundleV2Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.events.map((event) => event.key)).size !== value.events.length)
      context.addIssue({
        code: "custom",
        path: ["events"],
        message: "Custom component event keys must be unique",
      });
  });

export type CustomComponentOwnerV2 = z.infer<typeof customComponentOwnerV2Schema>;
export type CustomComponentReleaseV2 = z.infer<typeof customComponentReleaseV2Schema>;

/**
 * The context in which one application release places custom components: the placing application's
 * key and the exact module releases it binds. A custom component is placeable only by its owning
 * application, or by an application that binds the owning module release.
 */
export type CustomComponentPlacementContextV2 = Readonly<{
  applicationKey: string;
  boundModuleReleases: readonly Readonly<{ moduleKey: string; releaseVersion: string }>[];
}>;

/**
 * True when the placing application may place the custom component: it is the owning application,
 * or it binds the exact module release that owns it. Any other application is refused, so a custom
 * component never leaks into an unrelated application.
 */
export const customComponentPlacementAllowedV2 = (
  owner: CustomComponentOwnerV2,
  context: CustomComponentPlacementContextV2,
): boolean =>
  owner.kind === "application"
    ? owner.definitionKey === context.applicationKey
    : context.boundModuleReleases.some(
        (binding) =>
          binding.moduleKey === owner.definitionKey &&
          binding.releaseVersion === owner.releaseVersion,
      );

/**
 * True when any of the releases is a custom component release. Installation uses this on the exact
 * resolved releases so a package carrying custom components also requires `custom_code.manage`.
 */
export const containsCustomComponentReleasesV2 = (
  releases: readonly Readonly<{ customComponent?: CustomComponentReleaseV2 | undefined }>[],
): boolean => releases.some((release) => release.customComponent !== undefined);

/** One immutable, platform-owned block release used by validation and renderer lookup. */
export const platformBlockReleaseV2Schema = z
  .object({
    blockId: blockIdSchema,
    key: namespacedKeySchema,
    releaseVersion: semanticVersionSchema,
    contentFingerprint: fingerprintSchema,
    catalogueFingerprint: fingerprintSchema,
    name: labelSchema,
    icon: iconKeySchema,
    paletteGroup: blockPaletteGroupSchema,
    rendererKey: namespacedKeySchema,
    properties: z.array(blockPropertySchemaV2Schema),
    slots: z.array(blockSlotDeclarationV2Schema),
    capabilities: blockCapabilitiesV2Schema,
    /** Semantic events the component emits: the only events a flow binding may name for it. */
    supportedEvents: z.array(componentSemanticEventKindSchema),
    /** State operations a flow may apply to the component. */
    supportedStateOperations: z.array(componentStateOperationKindSchema),
    /**
     * Present only on a custom component release: the owning application or module release, its
     * typed declared events, data contract, text alternative and bundle manifest. A platform block
     * release carries none, and a custom component release carries no built-in semantic events.
     */
    customComponent: customComponentReleaseV2Schema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.customComponent !== undefined) {
      if (value.supportedEvents.length > 0)
        context.addIssue({
          code: "custom",
          path: ["supportedEvents"],
          message: "A custom component declares its own events, not built-in semantic events",
        });
      // A custom component is a page-level block rendered in a sandboxed frame: it hosts no child
      // placements, and the frame's title is always its accessible name.
      if (value.slots.length > 0)
        context.addIssue({
          code: "custom",
          path: ["slots"],
          message: "A custom component cannot contain other components",
        });
      if (value.capabilities.accessibleName !== "required")
        context.addIssue({
          code: "custom",
          path: ["capabilities", "accessibleName"],
          message: "A custom component requires an accessible name",
        });
    }
    if (new Set(value.supportedEvents).size !== value.supportedEvents.length)
      context.addIssue({
        code: "custom",
        path: ["supportedEvents"],
        message: "Supported events must be unique",
      });
    if (new Set(value.supportedStateOperations).size !== value.supportedStateOperations.length)
      context.addIssue({
        code: "custom",
        path: ["supportedStateOperations"],
        message: "Supported state operations must be unique",
      });
    if (new Set(value.properties.map((property) => property.key)).size !== value.properties.length)
      context.addIssue({
        code: "custom",
        path: ["properties"],
        message: "Property keys must be unique",
      });
    if (value.properties.filter((property) => property.derivesFieldInput === true).length > 1)
      context.addIssue({
        code: "custom",
        path: ["properties"],
        message: "A release may bind at most one automatic field input",
      });
    if (new Set(value.slots.map((slot) => slot.key)).size !== value.slots.length)
      context.addIssue({ code: "custom", path: ["slots"], message: "Slot keys must be unique" });
    for (const [index, slot] of value.slots.entries()) {
      const repeats = slot.repeats;
      if (repeats === undefined) continue;
      // A repeatable slot keys each item by a required text identity on the items of a declared
      // list of groups, and no other slot may share its item-key namespace.
      const list = value.properties.find((property) => property.key === repeats.items);
      const identity =
        list?.kind === "list" && list.item.kind === "group"
          ? list.item.properties.find((property) => property.key === repeats.identity)
          : undefined;
      if (identity?.kind !== "text" || !identity.required)
        context.addIssue({
          code: "custom",
          path: ["slots", index, "repeats"],
          message: "A repeatable slot must name a required text identity on a list of groups",
        });
      if (value.slots.some((other) => other !== slot && other.key.startsWith(`${slot.key}_`)))
        context.addIssue({
          code: "custom",
          path: ["slots", index, "key"],
          message: "A repeatable slot's item keys must not collide with another slot key",
        });
    }
    if (value.capabilities.accessibleName !== "not_applicable") {
      const propertyPath = value.capabilities.accessibleNamePropertyPath;
      let properties = value.properties;
      for (const [index, key] of propertyPath.entries()) {
        const property = properties.find((candidate) => candidate.key === key);
        const last = index === propertyPath.length - 1;
        if (
          property === undefined ||
          (last ? property.kind !== "text" : property.kind !== "group")
        ) {
          context.addIssue({
            code: "custom",
            path: ["capabilities", "accessibleNamePropertyPath", index],
            message: "Accessible name must select a declared text property through groups only",
          });
          break;
        }
        if (property.kind === "group") properties = property.properties;
      }
    }
  });

export const applicationCompositionPolicyV2Schema = z
  .object({
    maximumDepth: z.number().int().positive(),
    maximumPlacements: z.number().int().positive(),
  })
  .strict();

export const immutablePlatformBlockCatalogueV2Schema = z
  .object({
    compositionPolicy: applicationCompositionPolicyV2Schema,
    releases: z.array(platformBlockReleaseV2Schema),
  })
  .strict()
  .superRefine((value, context) => {
    const identities = value.releases.map(
      (release) => `${release.blockId}:${release.releaseVersion}`,
    );
    if (new Set(identities).size !== identities.length)
      context.addIssue({
        code: "custom",
        path: ["releases"],
        message: "Block releases must be unique",
      });
    const keysById = new Map<string, string>();
    const idsByKey = new Map<string, string>();
    for (const [index, release] of value.releases.entries()) {
      const id = String(release.blockId);
      if (
        (keysById.has(id) && keysById.get(id) !== release.key) ||
        (idsByKey.has(release.key) && idsByKey.get(release.key) !== id)
      )
        context.addIssue({
          code: "custom",
          path: ["releases", index, "key"],
          message: "A platform block key and permanent identity must map one to one",
        });
      keysById.set(id, release.key);
      idsByKey.set(release.key, id);
    }
  });

export const platformBlockDependenciesV2SchemaForCatalogue = (catalogueInput: unknown) => {
  const catalogue = immutablePlatformBlockCatalogueV2Schema.parse(catalogueInput);
  const releases = new Map(
    catalogue.releases.map((release) => [
      `${release.blockId}:${release.releaseVersion}`,
      `${release.contentFingerprint}:${release.catalogueFingerprint}`,
    ]),
  );
  return platformBlockDependenciesV2Schema.superRefine((dependencies, context) => {
    for (const [index, dependency] of dependencies.entries()) {
      const expected = releases.get(`${dependency.blockId}:${dependency.releaseVersion}`);
      const actual = `${dependency.contentFingerprint}:${dependency.catalogueFingerprint}`;
      if (expected !== actual)
        context.addIssue({
          code: "custom",
          path: [index],
          message: "A platform-block dependency must match one exact immutable catalogue release",
        });
    }
  });
};

export const platformBlockDependencyV2Schema = z
  .object({
    kind: z.literal("platform_block"),
    blockId: blockIdSchema,
    releaseVersion: semanticVersionSchema,
    contentFingerprint: fingerprintSchema,
    catalogueFingerprint: fingerprintSchema,
  })
  .strict();

export const sourcePlatformBlockDependencyV2Schema = z
  .object({
    kind: z.literal("platform_block"),
    block_id: blockIdSchema,
    release_version: semanticVersionSchema,
    content_fingerprint: fingerprintSchema,
    catalogue_fingerprint: fingerprintSchema,
  })
  .strict();

const deterministicDependencyList = <Entry extends { blockId: string; releaseVersion: string }>(
  entries: Entry[],
): boolean =>
  entries.every((entry, index) => {
    if (index === 0) return true;
    const previous = entries[index - 1]!;
    const previousBlock = String(previous.blockId);
    const currentBlock = String(entry.blockId);
    if (previousBlock !== currentBlock) return previousBlock < currentBlock;
    return previous.releaseVersion < entry.releaseVersion;
  });

export const platformBlockDependenciesV2Schema = z
  .array(platformBlockDependencyV2Schema)
  .superRefine((entries, context) => {
    const identities = entries.map((entry) => `${entry.blockId}@${entry.releaseVersion}`);
    if (new Set(identities).size !== identities.length)
      context.addIssue({
        code: "custom",
        message: "An application may depend on each exact platform block release only once",
      });
    if (!deterministicDependencyList(entries))
      context.addIssue({
        code: "custom",
        message: "Platform block dependencies must use permanent-identity order",
      });
  });

export const sourcePlatformBlockDependenciesV2Schema = z
  .array(sourcePlatformBlockDependencyV2Schema)
  .superRefine((entries, context) => {
    const normalized = entries.map((entry) => ({
      blockId: String(entry.block_id),
      releaseVersion: String(entry.release_version),
    }));
    const identities = normalized.map((entry) => `${entry.blockId}@${entry.releaseVersion}`);
    if (new Set(identities).size !== identities.length)
      context.addIssue({
        code: "custom",
        message: "An application may depend on each exact platform block release only once",
      });
    if (!deterministicDependencyList(normalized))
      context.addIssue({
        code: "custom",
        message: "Platform block dependencies must use permanent-identity order",
      });
  });

/** Placements name only their immutable block identity/version; fingerprints live in the manifest. */
export const platformBlockReferenceV2Schema = z
  .object({ blockId: blockIdSchema, releaseVersion: semanticVersionSchema })
  .strict();

export const sourcePlatformBlockReferenceV2Schema = z
  .object({ block_id: blockIdSchema, release_version: semanticVersionSchema })
  .strict();

const widthV2Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("content") }).strict(),
  z.object({ kind: z.literal("fill") }).strict(),
  z
    .object({
      kind: z.literal("grid"),
      startColumn: z.number().int().min(1).max(12),
      span: z.number().int().min(1).max(12),
    })
    .strict()
    .refine((value) => value.startColumn + value.span <= 13, {
      path: ["span"],
      message: "Placement exceeds the twelve-column grid",
    }),
]);

const sourceWidthV2Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("content") }).strict(),
  z.object({ kind: z.literal("fill") }).strict(),
  z
    .object({
      kind: z.literal("grid"),
      start_column: z.number().int().min(1).max(12),
      span: z.number().int().min(1).max(12),
    })
    .strict()
    .refine((value) => value.start_column + value.span <= 13, {
      path: ["span"],
      message: "Placement exceeds the twelve-column grid",
    }),
]);

const heightV2Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("content") }).strict(),
  z.object({ kind: z.literal("bounded"), units: positiveFiniteSchema }).strict(),
]);

export const placementLayoutV2Schema = z
  .object({ visible: z.boolean(), width: widthV2Schema, height: heightV2Schema })
  .strict();

export const sourcePlacementLayoutV2Schema = z
  .object({ visible: z.boolean(), width: sourceWidthV2Schema, height: heightV2Schema })
  .strict();

export const responsivePlacementV2Schema = z
  .object({
    desktop: placementLayoutV2Schema,
    tablet: placementLayoutV2Schema,
    phone: placementLayoutV2Schema,
  })
  .strict();

/** Missing authored tablet/phone entries inherit from the next wider breakpoint. */
export const sourceResponsivePlacementV2Schema = z
  .object({
    desktop: sourcePlacementLayoutV2Schema,
    tablet: sourcePlacementLayoutV2Schema.optional(),
    phone: sourcePlacementLayoutV2Schema.optional(),
  })
  .strict();

export const themeTokenKindV2Schema = z.enum([
  "color_pair",
  "typography",
  "spacing",
  "corners",
  "border",
  "elevation",
  "focus",
  "asset",
  "density",
]);

const colorComponentPattern = "(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
const hexColorPattern = /^#[0-9a-fA-F]{6}$/;
const oklchColorPattern = new RegExp(
  `^oklch\\(\\s*${colorComponentPattern}%?\\s+${colorComponentPattern}\\s+${colorComponentPattern}(?:deg)?\\s*(?:\\/\\s*${colorComponentPattern}%?)?\\s*\\)$`,
);

/** A theme colour is a six-digit hex value or an oklch() function, the two app-lightness forms. */
const colorSchema = z
  .string()
  .refine((value) => hexColorPattern.test(value) || oklchColorPattern.test(value), {
    message: "Use a six-digit hex or an oklch() colour value",
  });

/**
 * Declares how a platform theme colour is used, so readability checks follow the
 * catalogue's declaration rather than token names. Only platform theme releases
 * declare roles; application and placement overrides inherit them unchanged.
 */
export const themeColorRoleSchema = z.enum(["foreground", "background"]);
export type ThemeColorRole = z.infer<typeof themeColorRoleSchema>;

export const themeTokenValueV2Schema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("color_pair"),
      light: colorSchema,
      dark: colorSchema,
      role: themeColorRoleSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("typography"),
      family: builderKeySchema,
      sizeRem: positiveFiniteSchema,
      lineHeight: positiveFiniteSchema,
      weight: z.number().int().min(100).max(900),
    })
    .strict(),
  z.object({ kind: z.literal("spacing"), rem: nonNegativeFiniteSchema }).strict(),
  z.object({ kind: z.literal("corners"), rem: nonNegativeFiniteSchema }).strict(),
  z
    .object({
      kind: z.literal("border"),
      widthRem: nonNegativeFiniteSchema,
      style: z.enum(["solid", "dashed"]),
      colorToken: builderKeySchema,
    })
    .strict(),
  z.object({ kind: z.literal("elevation"), level: z.number().int().nonnegative() }).strict(),
  z
    .object({
      kind: z.literal("focus"),
      colorToken: builderKeySchema,
      widthRem: positiveFiniteSchema,
    })
    .strict(),
  z.object({ kind: z.literal("asset"), assetId: platformIdSchema }).strict(),
  z.object({ kind: z.literal("density"), value: z.enum(["compact", "comfortable"]) }).strict(),
]);

export const sourceThemeTokenValueV2Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("color_pair"), light: colorSchema, dark: colorSchema }).strict(),
  z
    .object({
      kind: z.literal("typography"),
      family: builderKeySchema,
      size_rem: positiveFiniteSchema,
      line_height: positiveFiniteSchema,
      weight: z.number().int().min(100).max(900),
    })
    .strict(),
  z.object({ kind: z.literal("spacing"), rem: nonNegativeFiniteSchema }).strict(),
  z.object({ kind: z.literal("corners"), rem: nonNegativeFiniteSchema }).strict(),
  z
    .object({
      kind: z.literal("border"),
      width_rem: nonNegativeFiniteSchema,
      style: z.enum(["solid", "dashed"]),
      color_token: builderKeySchema,
    })
    .strict(),
  z.object({ kind: z.literal("elevation"), level: z.number().int().nonnegative() }).strict(),
  z
    .object({
      kind: z.literal("focus"),
      color_token: builderKeySchema,
      width_rem: positiveFiniteSchema,
    })
    .strict(),
  z.object({ kind: z.literal("asset"), asset_id: platformIdSchema }).strict(),
  z.object({ kind: z.literal("density"), value: z.enum(["compact", "comfortable"]) }).strict(),
]);

export const exactPlatformThemeDependencyV2Schema = z
  .object({
    kind: z.literal("platform_theme"),
    catalogueThemeId: platformIdSchema,
    releaseVersion: semanticVersionSchema,
    contentFingerprint: fingerprintSchema,
    catalogueFingerprint: fingerprintSchema,
  })
  .strict();

export const sourceExactPlatformThemeDependencyV2Schema = z
  .object({
    kind: z.literal("platform_theme"),
    catalogue_theme_id: platformIdSchema,
    release_version: semanticVersionSchema,
    content_fingerprint: fingerprintSchema,
    catalogue_fingerprint: fingerprintSchema,
  })
  .strict();

/**
 * One option id from the generated shadcn/create theme catalogue (contracts/src/catalogue/
 * shadcn-create-theme-catalogue.generated.json, imported by the #1274 importer). Option ids are
 * lowercase kebab-case, for example `default-translucent`, and are matched against the catalogue
 * exactly.
 */
export const themeCatalogueOptionIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/**
 * One catalogue option id per shadcn/create dimension that #1274 publishes. A selection is
 * strict: every dimension appears exactly once and no other key is admitted. Runtime/theme
 * resolves the selected options into the complete token set and the style id, refusing an unknown
 * id, a refused option or a missing dimension. Fonts and icons are separate dimensions owned by
 * #1277 and #1278 and are absent until those releases land.
 */
export const applicationThemeSelectionV2Schema = z
  .object({
    style: themeCatalogueOptionIdSchema,
    baseColor: themeCatalogueOptionIdSchema,
    theme: themeCatalogueOptionIdSchema,
    chartColor: themeCatalogueOptionIdSchema,
    radius: themeCatalogueOptionIdSchema,
    menuColor: themeCatalogueOptionIdSchema,
    menuAccent: themeCatalogueOptionIdSchema,
  })
  .strict();
export type ApplicationThemeSelectionV2 = z.infer<typeof applicationThemeSelectionV2Schema>;

/**
 * The authored form of the catalogue selection, with the snake_case keys every source document
 * uses. Compilation maps it one to one onto the canonical selection above.
 */
export const sourceApplicationThemeSelectionV2Schema = z
  .object({
    style: themeCatalogueOptionIdSchema,
    base_color: themeCatalogueOptionIdSchema,
    theme: themeCatalogueOptionIdSchema,
    chart_color: themeCatalogueOptionIdSchema,
    radius: themeCatalogueOptionIdSchema,
    menu_color: themeCatalogueOptionIdSchema,
    menu_accent: themeCatalogueOptionIdSchema,
  })
  .strict();
export type SourceApplicationThemeSelectionV2 = z.infer<
  typeof sourceApplicationThemeSelectionV2Schema
>;

/** Maps an authored selection onto its canonical form. */
export const canonicalApplicationThemeSelectionV2 = (
  source: SourceApplicationThemeSelectionV2,
): ApplicationThemeSelectionV2 => ({
  style: source.style,
  baseColor: source.base_color,
  theme: source.theme,
  chartColor: source.chart_color,
  radius: source.radius,
  menuColor: source.menu_color,
  menuAccent: source.menu_accent,
});

/**
 * Canonical V2 themes contain the complete resolved application token set plus the catalogue
 * selection they were materialised from. Catalogue options are releases of the catalogue's base
 * platform theme release, so a theme pinned to that release always records its effective
 * selection. A theme pinned to an earlier release (for example 2.0.0) records none and keeps that
 * release's exact tokens.
 */
export const applicationThemeV2Schema = z
  .object({
    base: exactPlatformThemeDependencyV2Schema,
    selection: applicationThemeSelectionV2Schema.optional(),
    tokens: z.record(builderKeySchema, themeTokenValueV2Schema),
  })
  .strict();

/**
 * Authored V2 themes carry the catalogue selection and may omit overrides; compilation resolves
 * the selection into the full token set. On the catalogue's base release an absent selection means
 * the platform default (nova, neutral base colour, neutral theme); on an earlier release a
 * selection is refused and an absent one keeps that release's exact tokens.
 */
export const sourceApplicationThemeV2Schema = z
  .object({
    base: sourceExactPlatformThemeDependencyV2Schema,
    selection: sourceApplicationThemeSelectionV2Schema.optional(),
    token_overrides: z.record(builderKeySchema, sourceThemeTokenValueV2Schema),
  })
  .strict();

/** Complete immutable platform-theme content needed to materialise one V2 Application theme. */
export const platformThemeReleaseV2Schema = z
  .object({
    catalogueThemeId: platformIdSchema,
    releaseVersion: semanticVersionSchema,
    contentFingerprint: fingerprintSchema,
    catalogueFingerprint: fingerprintSchema,
    tokens: z.record(builderKeySchema, themeTokenValueV2Schema),
  })
  .strict();

/**
 * The token-role vocabulary shared by the platform theme release, the readability checks and
 * the renderer. Each entry names one role and the token kind a complete platform theme release
 * must map it with; a colour role also declares the foreground/background role the release must
 * mark that pair with, and a colour role that declares none stays unmarked (fills such as
 * `primary` are judged through their paired foreground). Defining the roles once here keeps
 * those three consumers from drifting into separate token conventions. A platform theme release
 * is complete only when it maps every role below; application and placement overrides inherit
 * the kind and declared colour role.
 */
export const platformThemeTokenRoleV2Schema = z
  .object({
    key: builderKeySchema,
    kind: themeTokenKindV2Schema,
    colorRole: themeColorRoleSchema.optional(),
  })
  .strict();
export type PlatformThemeTokenRoleV2 = z.infer<typeof platformThemeTokenRoleV2Schema>;

export const platformThemeTokenRolesV2 = [
  { key: "background", kind: "color_pair", colorRole: "background" },
  { key: "surface", kind: "color_pair", colorRole: "background" },
  { key: "text", kind: "color_pair", colorRole: "foreground" },
  { key: "muted_text", kind: "color_pair", colorRole: "foreground" },
  { key: "border_color", kind: "color_pair" },
  { key: "border", kind: "border" },
  { key: "primary", kind: "color_pair" },
  { key: "primary_foreground", kind: "color_pair", colorRole: "foreground" },
  { key: "secondary", kind: "color_pair" },
  { key: "secondary_foreground", kind: "color_pair", colorRole: "foreground" },
  { key: "danger", kind: "color_pair" },
  { key: "danger_foreground", kind: "color_pair", colorRole: "foreground" },
  { key: "danger_text", kind: "color_pair", colorRole: "foreground" },
  { key: "warning_text", kind: "color_pair", colorRole: "foreground" },
  { key: "info_text", kind: "color_pair", colorRole: "foreground" },
  // The shadcn CSS variables the shared components read. Each card, popover, accent and sidebar
  // surface carries its own foreground role, so the readability checks judge each painted pair.
  { key: "card", kind: "color_pair", colorRole: "background" },
  { key: "card_foreground", kind: "color_pair", colorRole: "foreground" },
  { key: "popover", kind: "color_pair", colorRole: "background" },
  { key: "popover_foreground", kind: "color_pair", colorRole: "foreground" },
  { key: "muted", kind: "color_pair", colorRole: "background" },
  { key: "accent", kind: "color_pair", colorRole: "background" },
  { key: "accent_foreground", kind: "color_pair", colorRole: "foreground" },
  { key: "input", kind: "color_pair" },
  { key: "ring", kind: "color_pair" },
  { key: "chart_1", kind: "color_pair" },
  { key: "chart_2", kind: "color_pair" },
  { key: "chart_3", kind: "color_pair" },
  { key: "chart_4", kind: "color_pair" },
  { key: "chart_5", kind: "color_pair" },
  { key: "sidebar", kind: "color_pair", colorRole: "background" },
  { key: "sidebar_foreground", kind: "color_pair", colorRole: "foreground" },
  { key: "sidebar_primary", kind: "color_pair" },
  { key: "sidebar_primary_foreground", kind: "color_pair", colorRole: "foreground" },
  { key: "sidebar_accent", kind: "color_pair" },
  { key: "sidebar_accent_foreground", kind: "color_pair", colorRole: "foreground" },
  { key: "sidebar_border", kind: "color_pair" },
  { key: "sidebar_ring", kind: "color_pair" },
  { key: "focus", kind: "focus" },
  { key: "body", kind: "typography" },
  { key: "heading", kind: "typography" },
  { key: "space_xs", kind: "spacing" },
  { key: "space_sm", kind: "spacing" },
  { key: "space_md", kind: "spacing" },
  { key: "space_lg", kind: "spacing" },
  { key: "radius_sm", kind: "corners" },
  { key: "radius_md", kind: "corners" },
  { key: "radius_lg", kind: "corners" },
  { key: "radius_base", kind: "corners" },
  { key: "elevation_low", kind: "elevation" },
  { key: "elevation_high", kind: "elevation" },
  { key: "density", kind: "density" },
] as const satisfies readonly PlatformThemeTokenRoleV2[];

/** Every token-role key a complete platform theme release must map. */
export type PlatformThemeTokenRoleKeyV2 = (typeof platformThemeTokenRolesV2)[number]["key"];

/**
 * Exact catalogue evidence locked by a trusted caller before pure V2 compilation.
 * Its fingerprint covers every field except the fingerprint itself.
 */
export const applicationCompositionCatalogueSnapshotV2Schema = z
  .object({
    contractVersion: z.literal("2.0.0"),
    fingerprint: fingerprintSchema,
    platformBlocks: immutablePlatformBlockCatalogueV2Schema,
    platformTheme: platformThemeReleaseV2Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const blockIdentities = value.platformBlocks.releases.map(
      (release) => `${release.blockId}@${release.releaseVersion}`,
    );
    if (new Set(blockIdentities).size !== blockIdentities.length)
      context.addIssue({
        code: "custom",
        path: ["platformBlocks", "releases"],
        message: "A compile snapshot may contain each exact platform block release only once",
      });
    const blockOrder = value.platformBlocks.releases.map((release) => ({
      blockId: String(release.blockId),
      releaseVersion: String(release.releaseVersion),
    }));
    if (!deterministicDependencyList(blockOrder))
      context.addIssue({
        code: "custom",
        path: ["platformBlocks", "releases"],
        message: "Compile snapshot block releases must use permanent-identity order",
      });
  });

/**
 * Closed, platform-declared protected read models. A page binds to one by key only; the request-time
 * resolver reads it live through the owning protected reader under the viewer's current authority.
 * Nothing here is copied into application records, and there are no free-form keys or filters.
 */
export const protectedReadModelKeys = [
  "people",
  "organization_accounts",
  "roles",
  "permissions",
  "groups",
  "effective_assignments",
  "role_activations",
  "delegations",
  "tenant_structure",
  "organization_invitations",
  "organization_runtime_settings",
  "tenants",
  "tenant_administrators",
  "installed_applications",
] as const;
export const protectedReadModelKeySchema = z.enum(protectedReadModelKeys);
export type ProtectedReadModelKey = z.infer<typeof protectedReadModelKeySchema>;

export const protectedReadModelDeclarations = Object.freeze({
  people: Object.freeze({
    label: "People (Group membership)",
    ownerReader: "access.listGroupMemberships",
    filters: Object.freeze(["groupId"] as const),
    resultContract: "ListOrganizationAdministrationMembershipsResult",
  }),
  organization_accounts: Object.freeze({
    label: "Organisation accounts",
    ownerReader: "access.listOrganizationAccounts",
    filters: Object.freeze([] as const),
    resultContract: "ListOrganizationAccountsResult",
  }),
  roles: Object.freeze({
    label: "Roles",
    ownerReader: "access.listRoles",
    filters: Object.freeze([] as const),
    resultContract: "ListOrganizationAdministrationRolesResult",
  }),
  permissions: Object.freeze({
    label: "Permissions",
    ownerReader: "access.listPermissions",
    filters: Object.freeze([] as const),
    resultContract: "ListOrganizationAdministrationPermissionsResult",
  }),
  groups: Object.freeze({
    label: "Groups",
    ownerReader: "access.listGroups",
    filters: Object.freeze([] as const),
    resultContract: "ListOrganizationAdministrationGroupsResult",
  }),
  effective_assignments: Object.freeze({
    label: "Effective assignments",
    ownerReader: "access.listRoleAssignments",
    filters: Object.freeze([] as const),
    resultContract: "ListOrganizationAdministrationRoleAssignmentsResult",
  }),
  role_activations: Object.freeze({
    label: "Role activations",
    ownerReader: "access.listRoleActivations",
    filters: Object.freeze([] as const),
    resultContract: "ListOrganizationAdministrationRoleActivationsResult",
  }),
  delegations: Object.freeze({
    label: "Delegations",
    ownerReader: "access.listDelegationAuthorities",
    filters: Object.freeze([] as const),
    resultContract: "ListOrganizationAdministrationDelegationAuthoritiesResult",
  }),
  tenant_structure: Object.freeze({
    label: "Tenant structure",
    ownerReader: "identity.listTenantHierarchy",
    filters: Object.freeze([] as const),
    resultContract: "TenantHierarchyResult",
  }),
  organization_invitations: Object.freeze({
    label: "Organisation invitations",
    ownerReader: "access.listOrganizationInvitations",
    filters: Object.freeze([] as const),
    resultContract: "ListOrganizationInvitationsResult",
  }),
  organization_runtime_settings: Object.freeze({
    label: "Organisation runtime settings",
    ownerReader: "access.readOrganizationRuntimeSettings",
    filters: Object.freeze([] as const),
    resultContract: "ReadOrganizationRuntimeSettingsResult",
  }),
  tenants: Object.freeze({
    label: "Tenants",
    ownerReader: "identity.listTenants",
    filters: Object.freeze([] as const),
    resultContract: "TenantLauncherResult",
  }),
  tenant_administrators: Object.freeze({
    label: "Tenant administrators",
    ownerReader: "identity.listTenantAdministrators",
    filters: Object.freeze([] as const),
    resultContract: "TenantAssignmentReadResult",
  }),
  // Installed applications already project a registered protected view, so the
  // ordinary query path reads them. The permitted-applications feed still serves
  // them to pages and no owner reader replaces it yet, so a page binding to this
  // read model refuses neutrally until that feed is replaced; `unavailable` is
  // that fact, not a reader that does not exist.
  installed_applications: Object.freeze({
    label: "Installed applications",
    ownerReader: "unavailable",
    filters: Object.freeze([] as const),
    resultContract: "ProtectedReadModelResolution",
  }),
} satisfies Record<
  ProtectedReadModelKey,
  Readonly<{
    label: string;
    ownerReader: string;
    filters: readonly "groupId"[];
    resultContract: string;
  }>
>);

/** A placement's binding names one declared read model and nothing else. */
export const protectedReadModelBindingV2Schema = z
  .object({ key: protectedReadModelKeySchema })
  .strict();
export type ProtectedReadModelBindingV2 = z.infer<typeof protectedReadModelBindingV2Schema>;

/** Request-time input is closed: a bounded page, the reader's own cursor and the declared filters. */
export const protectedReadModelPageRequestSchema = z
  .object({
    pageSize: z.number().int().min(1).max(100),
    after: z.uuid().optional(),
    groupId: z.uuid().optional(),
  })
  .strict();
export type ProtectedReadModelPageRequest = z.infer<typeof protectedReadModelPageRequestSchema>;

type BlockPlacementV2 = {
  block: z.infer<typeof platformBlockReferenceV2Schema>;
  viewPermissionKey?: z.infer<typeof namespacedKeySchema> | undefined;
  usePermissionKey?: z.infer<typeof namespacedKeySchema> | undefined;
  visibilityCondition?: z.infer<typeof conditionNodeSchema> | undefined;
  queryId?: z.infer<typeof queryIdSchema> | undefined;
  readModel?: ProtectedReadModelBindingV2 | undefined;
  settings: Record<string, BlockPropertyValueV2Contract>;
  themeOverrides: Record<string, z.infer<typeof themeTokenValueV2Schema>>;
  responsive: z.infer<typeof responsivePlacementV2Schema>;
  slots: Record<string, PlacementSlotV2>;
};
type PlacementSlotV2 = {
  placements: Record<string, BlockPlacementV2>;
  order: { desktop: string[]; tablet: string[]; phone: string[] };
};

type SourceBlockPlacementV2 = {
  block: z.infer<typeof sourcePlatformBlockReferenceV2Schema>;
  view_permission?: z.infer<typeof namespacedKeySchema> | undefined;
  use_permission?: z.infer<typeof namespacedKeySchema> | undefined;
  visibility_condition?: z.infer<typeof sourceQualifiedConditionSchema> | undefined;
  query?: z.infer<typeof builderKeySchema> | undefined;
  read_model?: ProtectedReadModelKey | undefined;
  settings: Record<string, SourceBlockPropertyValueV2Contract>;
  theme_overrides: Record<string, z.infer<typeof sourceThemeTokenValueV2Schema>>;
  responsive: z.infer<typeof sourceResponsivePlacementV2Schema>;
  slots: Record<string, SourcePlacementSlotV2>;
};
type SourcePlacementSlotV2 = {
  placements: Record<string, SourceBlockPlacementV2>;
  order: { desktop: string[]; tablet?: string[] | undefined; phone?: string[] | undefined };
};

const sameMembers = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length &&
  new Set(actual).size === actual.length &&
  actual.every((entry) => expected.includes(entry));

export const blockPlacementV2Schema: z.ZodType<BlockPlacementV2> = z.lazy(() =>
  z
    .object({
      block: platformBlockReferenceV2Schema,
      viewPermissionKey: namespacedKeySchema.optional(),
      usePermissionKey: namespacedKeySchema.optional(),
      visibilityCondition: conditionNodeSchema.optional(),
      queryId: queryIdSchema.optional(),
      readModel: protectedReadModelBindingV2Schema.optional(),
      settings: z.record(builderKeySchema, blockPropertyValueV2Schema),
      themeOverrides: z.record(builderKeySchema, themeTokenValueV2Schema),
      responsive: responsivePlacementV2Schema,
      slots: z.record(builderKeySchema, placementSlotV2Schema),
    })
    .strict(),
);

export const placementSlotV2Schema: z.ZodType<PlacementSlotV2> = z.lazy(() =>
  z
    .object({
      placements: z.record(containedComponentIdSchema, blockPlacementV2Schema),
      order: z
        .object({
          desktop: z.array(containedComponentIdSchema),
          tablet: z.array(containedComponentIdSchema),
          phone: z.array(containedComponentIdSchema),
        })
        .strict(),
    })
    .strict()
    .superRefine((value, context) => {
      const placements = Object.keys(value.placements);
      for (const breakpoint of ["desktop", "tablet", "phone"] as const)
        if (!sameMembers(value.order[breakpoint], placements))
          context.addIssue({
            code: "custom",
            path: ["order", breakpoint],
            message: "Each breakpoint order must be one complete placement permutation",
          });
    }),
);

export const sourceBlockPlacementV2Schema: z.ZodType<SourceBlockPlacementV2> = z.lazy(() =>
  z
    .object({
      block: sourcePlatformBlockReferenceV2Schema,
      view_permission: namespacedKeySchema.optional(),
      use_permission: namespacedKeySchema.optional(),
      visibility_condition: sourceQualifiedConditionSchema.optional(),
      query: sourceQualifiedQueryReferenceSchema.optional(),
      read_model: protectedReadModelKeySchema.optional(),
      settings: z.record(builderKeySchema, sourceBlockPropertyValueV2Schema),
      theme_overrides: z.record(builderKeySchema, sourceThemeTokenValueV2Schema),
      responsive: sourceResponsivePlacementV2Schema,
      slots: z.record(builderKeySchema, sourcePlacementSlotV2Schema),
    })
    .strict(),
);

export const sourcePlacementSlotV2Schema: z.ZodType<SourcePlacementSlotV2> = z.lazy(() =>
  z
    .object({
      placements: z.record(sourceAliasSchema, sourceBlockPlacementV2Schema),
      order: z
        .object({
          desktop: z.array(sourceAliasSchema),
          tablet: z.array(sourceAliasSchema).optional(),
          phone: z.array(sourceAliasSchema).optional(),
        })
        .strict(),
    })
    .strict()
    .superRefine((value, context) => {
      const placements = Object.keys(value.placements);
      for (const breakpoint of ["desktop", "tablet", "phone"] as const) {
        const order = value.order[breakpoint];
        if (order !== undefined && !sameMembers(order, placements))
          context.addIssue({
            code: "custom",
            path: ["order", breakpoint],
            message: "Each declared breakpoint order must be one complete placement permutation",
          });
      }
    }),
);

export const shellContentSlotV2Schema = z
  .object({
    slotId: containedComponentIdSchema,
    key: builderKeySchema,
    label: labelSchema,
    required: z.boolean(),
    allowedChildCategories: z.array(blockPaletteGroupSchema).min(1),
    parentPlacementId: containedComponentIdSchema,
    parentSlotKey: builderKeySchema,
  })
  .strict();

export const sourceShellContentSlotV2Schema = z
  .object({
    id: sourceAliasSchema,
    key: builderKeySchema,
    label: labelSchema,
    required: z.boolean(),
    allowed_child_categories: z.array(blockPaletteGroupSchema).min(1),
    parent_placement: sourceAliasSchema,
    parent_slot: builderKeySchema,
  })
  .strict();

const collectCanonicalPlacementSlots = (
  slot: PlacementSlotV2,
  result = new Map<string, Record<string, PlacementSlotV2>>(),
): Map<string, Record<string, PlacementSlotV2>> => {
  for (const [placementId, placement] of Object.entries(slot.placements)) {
    result.set(placementId, placement.slots);
    for (const child of Object.values(placement.slots))
      collectCanonicalPlacementSlots(child, result);
  }
  return result;
};

const collectSourcePlacementSlots = (
  slot: SourcePlacementSlotV2,
  result = new Map<string, Record<string, SourcePlacementSlotV2>>(),
): Map<string, Record<string, SourcePlacementSlotV2>> => {
  for (const [placementId, placement] of Object.entries(slot.placements)) {
    result.set(placementId, placement.slots);
    for (const child of Object.values(placement.slots)) collectSourcePlacementSlots(child, result);
  }
  return result;
};

export const canonicalPlacementEntriesV2 = (
  slot: PlacementSlotV2,
  result: [string, BlockPlacementV2][] = [],
): [string, BlockPlacementV2][] => {
  for (const [placementId, placement] of Object.entries(slot.placements)) {
    result.push([placementId, placement]);
    for (const child of Object.values(placement.slots)) canonicalPlacementEntriesV2(child, result);
  }
  return result;
};

export const sourcePlacementEntriesV2 = (
  slot: SourcePlacementSlotV2,
  result: [string, SourceBlockPlacementV2][] = [],
): [string, SourceBlockPlacementV2][] => {
  for (const [placementId, placement] of Object.entries(slot.placements)) {
    result.push([placementId, placement]);
    for (const child of Object.values(placement.slots)) sourcePlacementEntriesV2(child, result);
  }
  return result;
};

export const applicationShellV2Schema = z
  .object({
    shellId: shellIdSchema,
    key: builderKeySchema,
    name: labelSchema,
    layout: placementSlotV2Schema,
    contentSlots: z.array(shellContentSlotV2Schema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.contentSlots.map((slot) => slot.slotId);
    const keys = value.contentSlots.map((slot) => slot.key);
    const targets = value.contentSlots.map(
      (slot) => `${slot.parentPlacementId}:${slot.parentSlotKey}`,
    );
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: "custom",
        path: ["contentSlots"],
        message: "Shell content-slot identities must be unique",
      });
    if (new Set(keys).size !== keys.length)
      context.addIssue({
        code: "custom",
        path: ["contentSlots"],
        message: "Shell content-slot keys must be unique",
      });
    if (new Set(targets).size !== targets.length)
      context.addIssue({
        code: "custom",
        path: ["contentSlots"],
        message: "A shell location can expose only one content slot",
      });
    const placements = collectCanonicalPlacementSlots(value.layout);
    for (const [index, slot] of value.contentSlots.entries()) {
      const target = placements.get(slot.parentPlacementId)?.[slot.parentSlotKey];
      if (target === undefined)
        context.addIssue({
          code: "custom",
          path: ["contentSlots", index, "parentSlotKey"],
          message: "A shell content slot must target a declared slot on one shell placement",
        });
      else if (
        Object.keys(target.placements).length > 0 ||
        target.order.desktop.length > 0 ||
        target.order.tablet.length > 0 ||
        target.order.phone.length > 0
      )
        context.addIssue({
          code: "custom",
          path: ["contentSlots", index, "parentSlotKey"],
          message: "An exposed shell content slot must reserve an empty target for page content",
        });
    }
  });

export const sourceApplicationShellV2Schema = z
  .object({
    id: sourceAliasSchema,
    key: builderKeySchema,
    name: labelSchema,
    layout: sourcePlacementSlotV2Schema,
    content_slots: z.array(sourceShellContentSlotV2Schema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.content_slots.map((slot) => slot.id);
    const keys = value.content_slots.map((slot) => slot.key);
    const targets = value.content_slots.map(
      (slot) => `${slot.parent_placement}:${slot.parent_slot}`,
    );
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: "custom",
        path: ["content_slots"],
        message: "Shell content-slot aliases must be unique",
      });
    if (new Set(keys).size !== keys.length)
      context.addIssue({
        code: "custom",
        path: ["content_slots"],
        message: "Shell content-slot keys must be unique",
      });
    if (new Set(targets).size !== targets.length)
      context.addIssue({
        code: "custom",
        path: ["content_slots"],
        message: "A shell location can expose only one content slot",
      });
    const placements = collectSourcePlacementSlots(value.layout);
    for (const [index, slot] of value.content_slots.entries()) {
      const target = placements.get(slot.parent_placement)?.[slot.parent_slot];
      if (target === undefined)
        context.addIssue({
          code: "custom",
          path: ["content_slots", index, "parent_slot"],
          message: "A shell content slot must target a declared slot on one shell placement",
        });
      else if (
        Object.keys(target.placements).length > 0 ||
        target.order.desktop.length > 0 ||
        (target.order.tablet?.length ?? 0) > 0 ||
        (target.order.phone?.length ?? 0) > 0
      )
        context.addIssue({
          code: "custom",
          path: ["content_slots", index, "parent_slot"],
          message: "An exposed shell content slot must reserve an empty target for page content",
        });
    }
  });

export const pageCompositionV2Schema = z.discriminatedUnion("shellKind", [
  z.object({ shellKind: z.literal("default"), main: placementSlotV2Schema }).strict(),
  z
    .object({
      shellKind: z.literal("application"),
      shellId: shellIdSchema,
      content: z.record(containedComponentIdSchema, placementSlotV2Schema),
    })
    .strict(),
]);

export const sourcePageCompositionV2Schema = z.discriminatedUnion("shell_kind", [
  z.object({ shell_kind: z.literal("default"), main: sourcePlacementSlotV2Schema }).strict(),
  z
    .object({
      shell_kind: z.literal("application"),
      shell: sourceAliasSchema,
      content: z.record(sourceAliasSchema, sourcePlacementSlotV2Schema),
    })
    .strict(),
]);

/** One page shell with an exact, separately ordered content tree for every guided step. */
export const guidedFormPageCompositionV2Schema = z.discriminatedUnion("shellKind", [
  z
    .object({
      shellKind: z.literal("default"),
      stepContent: z.record(containedComponentIdSchema, placementSlotV2Schema),
    })
    .strict(),
  z
    .object({
      shellKind: z.literal("application"),
      shellId: shellIdSchema,
      stepContent: z.record(
        containedComponentIdSchema,
        z.record(containedComponentIdSchema, placementSlotV2Schema),
      ),
    })
    .strict(),
]);

export const sourceGuidedFormPageCompositionV2Schema = z.discriminatedUnion("shell_kind", [
  z
    .object({
      shell_kind: z.literal("default"),
      step_content: z.record(sourceAliasSchema, sourcePlacementSlotV2Schema),
    })
    .strict(),
  z
    .object({
      shell_kind: z.literal("application"),
      shell: sourceAliasSchema,
      step_content: z.record(
        sourceAliasSchema,
        z.record(sourceAliasSchema, sourcePlacementSlotV2Schema),
      ),
    })
    .strict(),
]);

export type PlatformBlockReleaseV2 = z.infer<typeof platformBlockReleaseV2Schema>;
export type ComponentStateOperationKind = z.infer<typeof componentStateOperationKindSchema>;
export type PlatformBlockDependencyV2 = z.infer<typeof platformBlockDependencyV2Schema>;
export type PlatformThemeReleaseV2 = z.infer<typeof platformThemeReleaseV2Schema>;
export type ApplicationCompositionPolicyV2 = z.infer<typeof applicationCompositionPolicyV2Schema>;
export type ImmutablePlatformBlockCatalogueV2 = z.infer<
  typeof immutablePlatformBlockCatalogueV2Schema
>;
export type ApplicationCompositionCatalogueSnapshotV2 = z.infer<
  typeof applicationCompositionCatalogueSnapshotV2Schema
>;
export type BlockPlacementV2Contract = z.infer<typeof blockPlacementV2Schema>;
export type ApplicationShellV2 = z.infer<typeof applicationShellV2Schema>;
export type PageCompositionV2 = z.infer<typeof pageCompositionV2Schema>;
export type GuidedFormPageCompositionV2 = z.infer<typeof guidedFormPageCompositionV2Schema>;

/*
 * Studio discovery projection. It republishes the declarations of one immutable platform block
 * catalogue, the same catalogue save and publish validation judge, so Studio offers only what that
 * catalogue declares and a new catalogue release needs no separate Studio allowlist. The catalogue
 * declares no per-release semantic events yet; the only operations projected are the placement
 * layout operations validation enforces from each release's capabilities.
 */

/** Property kinds whose value names an application-scoped or stored target. */
export const blockReferencePropertyKindsV2 = [
  "field_reference",
  "relationship_reference",
  "action_reference",
  "page_reference",
  "query_reference",
  "pipeline_reference",
  "record_type_reference",
  "record_reference",
  "asset_reference",
] as const satisfies readonly BlockPropertySchemaV2Contract["kind"][];
export type BlockReferencePropertyKindV2 = (typeof blockReferencePropertyKindsV2)[number];

const blockReferencePropertyKinds: ReadonlySet<string> = new Set(blockReferencePropertyKindsV2);

export const isBlockReferencePropertyKindV2 = (
  kind: BlockPropertySchemaV2Contract["kind"],
): kind is BlockReferencePropertyKindV2 => blockReferencePropertyKinds.has(kind);

/** A public page admits only releases whose capabilities allow the public surface. */
export type CompositionSurfaceV2 = "authenticated" | "public";

/** Exact release identity and palette metadata; its fingerprints fill a dependency manifest. */
export type PlatformBlockReleaseSummaryV2 = Readonly<
  Pick<
    PlatformBlockReleaseV2,
    | "blockId"
    | "key"
    | "releaseVersion"
    | "contentFingerprint"
    | "catalogueFingerprint"
    | "name"
    | "icon"
    | "paletteGroup"
    | "rendererKey"
  > & { publicSurface: PlatformBlockReleaseV2["capabilities"]["publicSurface"] }
>;

export type ComponentPropertyControlV2 = Readonly<{
  /** The exact catalogue declaration, including every constraint validation applies to it. */
  declaration: BlockPropertySchemaV2Contract;
  /** Validation refuses the placement when the author leaves this value unset. */
  valueRequired: boolean;
  /** This text property supplies the component's accessible name. */
  accessibleName: boolean;
  referenceKind?: BlockReferencePropertyKindV2;
  /** Controls of a group declaration, in declaration order. */
  properties?: readonly ComponentPropertyControlV2[];
  /** Control for each item of a list declaration. */
  item?: ComponentPropertyControlV2;
}>;

/** Placement layout choices; content width, fill width and content height are always available. */
export type ComponentLayoutOperationsV2 = Readonly<{
  /** Visibility may differ between desktop, tablet and phone. */
  responsiveVisibility: boolean;
  /** Placements inside this component's slots may use a different order per breakpoint. */
  responsiveChildOrder: boolean;
  /** Width may use a twelve-column grid span. */
  gridWidth: boolean;
  /** Height may be bounded. */
  boundedHeight: boolean;
}>;

export type ComponentDiscoverySlotV2 = Readonly<{
  key: string;
  label: string;
  required: boolean;
  allowedChildCategories: readonly BlockPaletteGroup[];
  /**
   * Present on a repeatable slot: the inspector offers one child slot per item of the list
   * property `items`, each keyed by the item's text property `identity`. Absent on a fixed slot.
   */
  repeats?: Readonly<{ items: string; identity: string }>;
  /** Exact releases validation admits in this slot on the projected surface. */
  allowedChildren: readonly PlatformBlockReleaseSummaryV2[];
}>;

export type ComponentDiscoveryV2 = Readonly<{
  release: PlatformBlockReleaseSummaryV2;
  /** Semantic events a flow binding may name for this release, as the catalogue declares them. */
  supportedEvents: readonly ComponentSemanticEventKind[];
  /** State operations a flow may apply to this release, as the catalogue declares them. */
  supportedStateOperations: readonly ComponentStateOperationKind[];
  accessibleName: PlatformBlockReleaseV2["capabilities"]["accessibleName"];
  properties: readonly ComponentPropertyControlV2[];
  /** Distinct reference kinds declared anywhere in the component's properties. */
  referenceKinds: readonly BlockReferencePropertyKindV2[];
  slots: readonly ComponentDiscoverySlotV2[];
  layoutOperations: ComponentLayoutOperationsV2;
}>;

export type PlatformCatalogueDiscoveryV2 = Readonly<{
  surface: CompositionSurfaceV2;
  compositionPolicy: ApplicationCompositionPolicyV2;
  /** Every release offered on the surface, in catalogue order. */
  components: readonly ComponentDiscoveryV2[];
  /** Keyed by platformBlockReleaseIdentityV2, the exact identity a placement names. */
  componentsByRelease: ReadonlyMap<string, ComponentDiscoveryV2>;
}>;

export const platformBlockReleaseIdentityV2 = (
  block: Readonly<{ blockId: string; releaseVersion: string }>,
): string => `${block.blockId}:${block.releaseVersion}`;

const summarisePlatformBlockReleaseV2 = (
  release: PlatformBlockReleaseV2,
): PlatformBlockReleaseSummaryV2 =>
  Object.freeze({
    blockId: release.blockId,
    key: release.key,
    releaseVersion: release.releaseVersion,
    contentFingerprint: release.contentFingerprint,
    catalogueFingerprint: release.catalogueFingerprint,
    name: release.name,
    icon: release.icon,
    paletteGroup: release.paletteGroup,
    rendererKey: release.rendererKey,
    publicSurface: release.capabilities.publicSurface,
  });

/**
 * Mirrors the catalogue validation rules: an unset value is refused when its declaration is
 * required without a default, and a required accessible name must be reachable after defaults
 * along its property path.
 */
const projectPropertyControlsV2 = (
  declarations: readonly BlockPropertySchemaV2Contract[],
  namePath: readonly string[] | undefined,
  nameRequired: boolean,
): readonly ComponentPropertyControlV2[] =>
  Object.freeze(
    declarations.map((declaration): ComponentPropertyControlV2 => {
      const rest =
        namePath !== undefined && namePath[0] === declaration.key ? namePath.slice(1) : undefined;
      const nameValueRequired =
        rest !== undefined && nameRequired && declaration.defaultValue === undefined;
      return Object.freeze({
        declaration,
        valueRequired:
          (declaration.required && declaration.defaultValue === undefined) || nameValueRequired,
        accessibleName: rest !== undefined && rest.length === 0,
        ...(isBlockReferencePropertyKindV2(declaration.kind)
          ? { referenceKind: declaration.kind }
          : {}),
        ...(declaration.kind === "group"
          ? {
              properties: projectPropertyControlsV2(
                declaration.properties,
                rest !== undefined && rest.length > 0 ? rest : undefined,
                nameValueRequired,
              ),
            }
          : {}),
        ...(declaration.kind === "list"
          ? { item: projectPropertyControlsV2([declaration.item], undefined, false)[0]! }
          : {}),
      });
    }),
  );

const collectReferenceKindsV2 = (
  controls: readonly ComponentPropertyControlV2[],
  kinds: Set<BlockReferencePropertyKindV2>,
): Set<BlockReferencePropertyKindV2> => {
  for (const control of controls) {
    if (control.referenceKind !== undefined) kinds.add(control.referenceKind);
    if (control.properties !== undefined) collectReferenceKindsV2(control.properties, kinds);
    if (control.item !== undefined) collectReferenceKindsV2([control.item], kinds);
  }
  return kinds;
};

/** Projects the releases, property controls, slot children and layout operations of one surface. */
export const projectPlatformCatalogueDiscoveryV2 = (
  catalogue: ImmutablePlatformBlockCatalogueV2,
  surface: CompositionSurfaceV2 = "authenticated",
): PlatformCatalogueDiscoveryV2 => {
  const offered = catalogue.releases.filter(
    (release) => surface === "authenticated" || release.capabilities.publicSurface === "allowed",
  );
  const summaries = offered.map(summarisePlatformBlockReleaseV2);
  const components = Object.freeze(
    offered.map((release, index): ComponentDiscoveryV2 => {
      const capabilities = release.capabilities;
      const properties = projectPropertyControlsV2(
        release.properties,
        capabilities.accessibleName === "not_applicable"
          ? undefined
          : capabilities.accessibleNamePropertyPath,
        capabilities.accessibleName === "required",
      );
      return Object.freeze({
        release: summaries[index]!,
        supportedEvents: Object.freeze([...release.supportedEvents]),
        supportedStateOperations: Object.freeze([...release.supportedStateOperations]),
        accessibleName: capabilities.accessibleName,
        properties,
        referenceKinds: Object.freeze([...collectReferenceKindsV2(properties, new Set())]),
        slots: Object.freeze(
          release.slots.map((slot): ComponentDiscoverySlotV2 => {
            const categories = new Set<BlockPaletteGroup>(slot.allowedChildCategories);
            return Object.freeze({
              key: slot.key,
              label: slot.label,
              required: slot.required,
              allowedChildCategories: Object.freeze([...slot.allowedChildCategories]),
              ...(slot.repeats === undefined
                ? {}
                : { repeats: Object.freeze({ ...slot.repeats }) }),
              allowedChildren: Object.freeze(
                summaries.filter((child) => categories.has(child.paletteGroup)),
              ),
            });
          }),
        ),
        layoutOperations: Object.freeze({
          responsiveVisibility: capabilities.responsiveVisibility,
          responsiveChildOrder: capabilities.responsiveOrder,
          gridWidth: capabilities.gridWidth,
          boundedHeight: capabilities.height === "content_or_bounded",
        }),
      });
    }),
  );
  return Object.freeze({
    surface,
    compositionPolicy: catalogue.compositionPolicy,
    components,
    componentsByRelease: new Map(
      components.map((component) => [platformBlockReleaseIdentityV2(component.release), component]),
    ),
  });
};
