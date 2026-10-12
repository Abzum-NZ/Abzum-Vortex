import { z } from "zod";
import {
  blockPaletteGroupSchema,
  workflowValueTypeSchema,
  type BlockPaletteGroup,
} from "../catalogue/catalogues";
import { labelSchema, safeHttpsUrlSchema } from "../catalogue/common";
import {
  sourceAliasSchema,
  sourceQualifiedConditionSchema,
  sourceQualifiedFieldSchema,
  sourceQualifiedQueryReferenceSchema,
  sourceQualifiedRecordTypeSchema,
  sourceQualifiedRelationshipSchema,
  sourceProvenanceTarget,
  sourceProvenanceUnchanged,
} from "./definition-source-common";
import {
  componentSemanticEventKindSchema,
  type ComponentSemanticEventKind,
} from "./application-flow-bindings";
import { recordTypeReferenceSchema } from "./definitions";
import { conditionNodeSchema } from "./module-foundation-contracts";
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
} from "../catalogue/identifiers";
import {
  richTextDocumentSchema,
  richTextElementKindSchema,
  type RichTextInline,
} from "../records/rich-text";
import type { DefinitionRuleFailureFamily } from "../catalogue/validation-errors";

export {
  richTextDocumentSchema,
  richTextElementKindSchema,
} from "../records/rich-text";

const iconKeySchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const nonNegativeFiniteSchema = z.number().finite().nonnegative();
const positiveFiniteSchema = z.number().finite().positive();

export type BlockPropertyValueContract =
  | { kind: "text"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "choice"; value: string }
  | { kind: "rich_text"; value: z.infer<typeof richTextDocumentSchema> }
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
  | { kind: "group"; properties: Record<string, BlockPropertyValueContract> }
  | { kind: "list"; items: BlockPropertyValueContract[] };

/** Canonical  values are closed and kind-discriminated; there is no arbitrary JSON branch. */
export const blockPropertyValueSchema: z.ZodType<BlockPropertyValueContract> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: sourceProvenanceUnchanged(z.literal("text")),
        value: sourceProvenanceUnchanged(z.string()),
      })
      .strict(),
    z
      .object({
        kind: sourceProvenanceUnchanged(z.literal("number")),
        value: sourceProvenanceUnchanged(z.number().finite()),
      })
      .strict(),
    z
      .object({
        kind: sourceProvenanceUnchanged(z.literal("boolean")),
        value: sourceProvenanceUnchanged(z.boolean()),
      })
      .strict(),
    z
      .object({
        kind: sourceProvenanceUnchanged(z.literal("choice")),
        value: sourceProvenanceUnchanged(builderKeySchema),
      })
      .strict(),
    z
      .object({
        kind: sourceProvenanceUnchanged(z.literal("rich_text")),
        value: sourceProvenanceUnchanged(richTextDocumentSchema, true),
      })
      .strict(),
    z
      .object({
        kind: sourceProvenanceUnchanged(z.literal("url")),
        value: sourceProvenanceUnchanged(safeHttpsUrlSchema),
      })
      .strict(),
    z
      .object({
        kind: sourceProvenanceUnchanged(z.literal("asset_reference")),
        assetId: sourceProvenanceUnchanged(platformIdSchema),
      })
      .strict(),
    z
      .object({
        kind: sourceProvenanceUnchanged(z.literal("icon")),
        iconKey: sourceProvenanceUnchanged(builderKeySchema),
      })
      .strict(),
    z
      .object({
        kind: sourceProvenanceUnchanged(z.literal("theme_token")),
        tokenKey: sourceProvenanceUnchanged(builderKeySchema),
      })
      .strict(),
    z
      .object({
        kind: sourceProvenanceUnchanged(z.literal("field_reference")),
        fieldId: sourceProvenanceUnchanged(fieldIdSchema),
      })
      .strict(),
    z
      .object({
        kind: sourceProvenanceUnchanged(z.literal("relationship_reference")),
        relationshipId: sourceProvenanceUnchanged(containedComponentIdSchema),
      })
      .strict(),
    z
      .object({
        kind: sourceProvenanceUnchanged(z.literal("action_reference")),
        actionKey: sourceProvenanceUnchanged(namespacedKeySchema),
      })
      .strict(),
    z
      .object({
        kind: sourceProvenanceUnchanged(z.literal("page_reference")),
        pageId: sourceProvenanceUnchanged(pageIdSchema),
      })
      .strict(),
    z
      .object({
        kind: sourceProvenanceUnchanged(z.literal("query_reference")),
        queryId: sourceProvenanceUnchanged(queryIdSchema),
      })
      .strict(),
    z
      .object({
        kind: sourceProvenanceUnchanged(z.literal("pipeline_reference")),
        pipelineId: sourceProvenanceUnchanged(pipelineIdSchema),
      })
      .strict(),
    z
      .object({
        kind: sourceProvenanceUnchanged(z.literal("record_type_reference")),
        recordType: sourceProvenanceUnchanged(recordTypeReferenceSchema),
      })
      .strict(),
    z
      .object({
        kind: sourceProvenanceUnchanged(z.literal("record_reference")),
        recordType: sourceProvenanceUnchanged(recordTypeReferenceSchema),
        recordId: sourceProvenanceUnchanged(recordIdSchema),
      })
      .strict(),
    z
      .object({
        kind: sourceProvenanceUnchanged(z.literal("group")),
        properties: sourceProvenanceUnchanged(z.record(builderKeySchema, blockPropertyValueSchema)),
      })
      .strict(),
    z
      .object({
        kind: sourceProvenanceUnchanged(z.literal("list")),
        items: sourceProvenanceUnchanged(z.array(blockPropertyValueSchema)),
      })
      .strict(),
  ]),
);

export type SourceBlockPropertyValueContract =
  | { kind: "text"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "choice"; value: string }
  | { kind: "rich_text"; value: z.infer<typeof richTextDocumentSchema> }
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
  | { kind: "group"; properties: Record<string, SourceBlockPropertyValueContract> }
  | { kind: "list"; items: SourceBlockPropertyValueContract[] };

/** Authored  values retain portable aliases while preserving the same closed value kinds. */
export const sourceBlockPropertyValueSchema: z.ZodType<SourceBlockPropertyValueContract> = z.lazy(
  () =>
    z.discriminatedUnion("kind", [
      z
        .object({
          kind: sourceProvenanceUnchanged(z.literal("text")),
          value: sourceProvenanceUnchanged(z.string()),
        })
        .strict(),
      z
        .object({
          kind: sourceProvenanceUnchanged(z.literal("number")),
          value: sourceProvenanceUnchanged(z.number().finite()),
        })
        .strict(),
      z
        .object({
          kind: sourceProvenanceUnchanged(z.literal("boolean")),
          value: sourceProvenanceUnchanged(z.boolean()),
        })
        .strict(),
      z
        .object({
          kind: sourceProvenanceUnchanged(z.literal("choice")),
          value: sourceProvenanceUnchanged(builderKeySchema),
        })
        .strict(),
      z
        .object({
          kind: sourceProvenanceUnchanged(z.literal("rich_text")),
          value: sourceProvenanceUnchanged(richTextDocumentSchema, true),
        })
        .strict(),
      z
        .object({
          kind: sourceProvenanceUnchanged(z.literal("url")),
          value: sourceProvenanceUnchanged(safeHttpsUrlSchema),
        })
        .strict(),
      z
        .object({
          kind: sourceProvenanceUnchanged(z.literal("asset_reference")),
          asset_id: sourceProvenanceTarget(platformIdSchema, ["assetId"]),
        })
        .strict(),
      z
        .object({
          kind: sourceProvenanceUnchanged(z.literal("icon")),
          icon_key: sourceProvenanceTarget(builderKeySchema, ["iconKey"]),
        })
        .strict(),
      z
        .object({
          kind: sourceProvenanceUnchanged(z.literal("theme_token")),
          token: sourceProvenanceTarget(builderKeySchema, ["tokenKey"]),
        })
        .strict(),
      z
        .object({
          kind: sourceProvenanceUnchanged(z.literal("field_reference")),
          field: sourceProvenanceTarget(sourceQualifiedFieldSchema, ["fieldId"]),
        })
        .strict(),
      z
        .object({
          kind: sourceProvenanceUnchanged(z.literal("relationship_reference")),
          relationship: sourceProvenanceTarget(sourceQualifiedRelationshipSchema, [
            "relationshipId",
          ]),
        })
        .strict(),
      z
        .object({
          kind: sourceProvenanceUnchanged(z.literal("action_reference")),
          action: sourceProvenanceTarget(namespacedKeySchema, ["actionKey"]),
        })
        .strict(),
      z
        .object({
          kind: sourceProvenanceUnchanged(z.literal("page_reference")),
          page: sourceProvenanceTarget(builderKeySchema, ["pageId"]),
        })
        .strict(),
      z
        .object({
          kind: sourceProvenanceUnchanged(z.literal("query_reference")),
          query: sourceProvenanceTarget(sourceQualifiedQueryReferenceSchema, ["queryId"]),
        })
        .strict(),
      z
        .object({
          kind: sourceProvenanceUnchanged(z.literal("pipeline_reference")),
          pipeline: sourceProvenanceTarget(builderKeySchema, ["pipelineId"]),
        })
        .strict(),
      z
        .object({
          kind: sourceProvenanceUnchanged(z.literal("record_type_reference")),
          record_type: sourceProvenanceTarget(sourceQualifiedRecordTypeSchema, ["recordType/**"]),
        })
        .strict(),
      z
        .object({
          kind: sourceProvenanceUnchanged(z.literal("record_reference")),
          record_type: sourceProvenanceTarget(sourceQualifiedRecordTypeSchema, ["recordType/**"]),
          record_id: sourceProvenanceTarget(z.uuid(), ["recordId"]),
        })
        .strict(),
      z
        .object({
          kind: sourceProvenanceUnchanged(z.literal("group")),
          properties: sourceProvenanceUnchanged(
            z.record(builderKeySchema, sourceBlockPropertyValueSchema),
          ),
        })
        .strict(),
      z
        .object({
          kind: sourceProvenanceUnchanged(z.literal("list")),
          items: sourceProvenanceUnchanged(z.array(sourceBlockPropertyValueSchema)),
        })
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
  "date_time",
  "choice",
  "several_choices",
  "link",
] as const;
export type FieldInputControlKey = (typeof fieldInputControlKeys)[number];

type BlockPropertySchemaBase = {
  key: string;
  label: string;
  help?: string | undefined;
  required: boolean;
  defaultValue?: BlockPropertyValueContract | undefined;
  /**
   * Present only on the `field_reference` property an automatic field input binds its record field
   * to: the compiler then derives that input's name, label, requirement, choices and control from
   * the referenced module field. Authored and canonical values of the release are unchanged.
   */
  derivesFieldInput?: boolean | undefined;
};

export type BlockPropertySchemaContract =
  | (BlockPropertySchemaBase & { kind: "text"; minLength: number; maxLength: number })
  | (BlockPropertySchemaBase & {
      kind: "number";
      integer: boolean;
      minimum?: number | undefined;
      maximum?: number | undefined;
    })
  | (BlockPropertySchemaBase & { kind: "boolean" })
  | (BlockPropertySchemaBase & {
      kind: "choice";
      options: { key: string; label: string }[];
    })
  | (BlockPropertySchemaBase & {
      kind: "rich_text";
      allowedElements: z.infer<typeof richTextElementKindSchema>[];
    })
  | (BlockPropertySchemaBase & { kind: "url" | "asset_reference" | "icon" })
  | (BlockPropertySchemaBase & {
      kind: "theme_token";
      tokenKind: z.infer<typeof themeTokenKindSchema>;
    })
  | (BlockPropertySchemaBase & {
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
  | (BlockPropertySchemaBase & {
      kind: "group";
      properties: BlockPropertySchemaContract[];
    })
  | (BlockPropertySchemaBase & {
      kind: "list";
      minimumItems: number;
      maximumItems: number;
      item: BlockPropertySchemaContract;
    });

const propertySchemaBase = {
  key: sourceProvenanceUnchanged(builderKeySchema),
  label: sourceProvenanceUnchanged(labelSchema),
  help: sourceProvenanceUnchanged(z.string().min(1).max(1_000).optional()),
  required: sourceProvenanceUnchanged(z.boolean()),
  defaultValue: sourceProvenanceUnchanged(blockPropertyValueSchema.optional()),
  /**
   * Present only on the `field_reference` property an automatic field input binds its record field
   * to: the compiler derives that input's name, label, requirement, choices and control from the
   * referenced module field. Authored and canonical values of the release are unchanged.
   */
  derivesFieldInput: sourceProvenanceUnchanged(z.boolean().optional()),
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

type RichTextSettingDocument = z.infer<typeof richTextDocumentSchema>;

const richTextSettingViolations = (
  document: RichTextSettingDocument,
): Readonly<{ kinds: ReadonlySet<string>; unsafe: boolean }> => {
  const kinds = new Set<string>();
  let unsafe = false;
  const visitInline = (inline: RichTextInline): void => {
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
export type ComponentSettingValue = BlockPropertyValueContract | SourceBlockPropertyValueContract;

/**
 * The one component-setting validator: it judges a supplied setting value against its exact
 * declaration, including unsafe text, so the designer can never accept what publishing rejects.
 * Authored and canonical values share the same kind vocabulary, so both forms use this function.
 */
export const validateComponentSettingValue = (
  value: ComponentSettingValue,
  declaration: BlockPropertySchemaContract,
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
  declarations: readonly BlockPropertySchemaContract[],
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
    const capability = settingOptionalChoice(action["capability"], recordsTableActionCapabilities);
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
const defaultMatchesProperty = (schema: BlockPropertySchemaContract): boolean => {
  const value = schema.defaultValue;
  if (value === undefined) return true;
  const complete = (
    nested: BlockPropertyValueContract,
    declaration: BlockPropertySchemaContract,
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
export const blockPropertySchema: z.ZodType<BlockPropertySchemaContract> = z.lazy(() =>
  z
    .discriminatedUnion("kind", [
      z
        .object({
          ...propertySchemaBase,
          kind: sourceProvenanceUnchanged(z.literal("text")),
          minLength: sourceProvenanceUnchanged(z.number().int().nonnegative()),
          maxLength: sourceProvenanceUnchanged(z.number().int().positive()),
        })
        .strict()
        .refine((value) => value.maxLength >= value.minLength, {
          path: ["maxLength"],
          message: "Maximum text length cannot be shorter than minimum length",
        }),
      z
        .object({
          ...propertySchemaBase,
          kind: sourceProvenanceUnchanged(z.literal("number")),
          integer: sourceProvenanceUnchanged(z.boolean()),
          minimum: sourceProvenanceUnchanged(z.number().finite().optional()),
          maximum: sourceProvenanceUnchanged(z.number().finite().optional()),
        })
        .strict()
        .refine(
          (value) =>
            value.minimum === undefined ||
            value.maximum === undefined ||
            value.maximum >= value.minimum,
          { path: ["maximum"], message: "Maximum number cannot be less than minimum" },
        ),
      z
        .object({ ...propertySchemaBase, kind: sourceProvenanceUnchanged(z.literal("boolean")) })
        .strict(),
      z
        .object({
          ...propertySchemaBase,
          kind: sourceProvenanceUnchanged(z.literal("choice")),
          options: sourceProvenanceUnchanged(
            z
              .array(
                z
                  .object({
                    key: sourceProvenanceUnchanged(builderKeySchema),
                    label: sourceProvenanceUnchanged(labelSchema),
                  })
                  .strict(),
              )
              .min(1),
          ),
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
          kind: sourceProvenanceUnchanged(z.literal("rich_text")),
          allowedElements: sourceProvenanceUnchanged(z.array(richTextElementKindSchema).min(1)),
        })
        .strict()
        .refine((value) => new Set(value.allowedElements).size === value.allowedElements.length, {
          path: ["allowedElements"],
          message: "Allowed rich-text elements must be unique",
        }),
      z
        .object({ ...propertySchemaBase, kind: sourceProvenanceUnchanged(z.literal("url")) })
        .strict(),
      z
        .object({
          ...propertySchemaBase,
          kind: sourceProvenanceUnchanged(z.literal("asset_reference")),
        })
        .strict(),
      z
        .object({ ...propertySchemaBase, kind: sourceProvenanceUnchanged(z.literal("icon")) })
        .strict(),
      z
        .object({
          ...propertySchemaBase,
          kind: sourceProvenanceUnchanged(z.literal("theme_token")),
          tokenKind: sourceProvenanceUnchanged(
            z.enum([
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
          ),
        })
        .strict(),
      z
        .object({
          ...propertySchemaBase,
          kind: sourceProvenanceUnchanged(
            z.enum([
              "field_reference",
              "relationship_reference",
              "action_reference",
              "page_reference",
              "query_reference",
              "pipeline_reference",
              "record_type_reference",
              "record_reference",
            ]),
          ),
        })
        .strict(),
      z
        .object({
          ...propertySchemaBase,
          kind: sourceProvenanceUnchanged(z.literal("group")),
          properties: sourceProvenanceUnchanged(z.array(blockPropertySchema)),
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
          kind: sourceProvenanceUnchanged(z.literal("list")),
          minimumItems: sourceProvenanceUnchanged(z.number().int().nonnegative()),
          maximumItems: sourceProvenanceUnchanged(z.number().int().positive()),
          item: sourceProvenanceUnchanged(blockPropertySchema),
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
  properties: readonly BlockPropertySchemaContract[],
): BlockPropertySchemaContract | undefined =>
  properties.find(
    (property) => property.kind === "field_reference" && property.derivesFieldInput === true,
  );

export const blockSlotDeclarationSchema = z
  .object({
    key: sourceProvenanceUnchanged(builderKeySchema),
    label: sourceProvenanceUnchanged(labelSchema),
    required: sourceProvenanceUnchanged(z.boolean()),
    allowedChildCategories: sourceProvenanceUnchanged(z.array(blockPaletteGroupSchema).min(1)),
    /**
     * Present on a repeatable slot. The release then owns one child slot per item of the list
     * property named by `items`, each keyed by the item's stable identity read from that item's
     * text property named by `identity`. Absent on a fixed slot, whose `key` is its one slot key.
     */
    repeats: sourceProvenanceUnchanged(
      z
        .object({
          items: sourceProvenanceUnchanged(builderKeySchema),
          identity: sourceProvenanceUnchanged(builderKeySchema),
        })
        .strict()
        .optional(),
    ),
  })
  .strict();

/**
 * The exact placement slot key one repeatable item owns: `${family}_${identity}`. The family is
 * the repeatable slot declaration's key, so every slot the release declares stays a valid builder
 * key and two repeatable slot families on one release never collide.
 */
export const repeatableSlotKey = (family: string, identity: string): string =>
  `${family}_${identity}`;

/**
 * The stable item identities one repeatable slot declaration owns, read from a placement's
 * settings. An absent or wrong-kind list owns none. Every item of the list contributes exactly
 * one identity, returned verbatim in item order and including duplicates: an item that is not a
 * group or whose identity is not text contributes the empty identity. Callers therefore judge
 * every item with `isRepeatableSlotIdentity` and refuse a duplicate, rather than silently
 * dropping a malformed item or collapsing two items onto one slot.
 */
export const repeatableSlotItemIdentities = (
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
export const isRepeatableSlotIdentity = (family: string, identity: string): boolean =>
  builderKeySchema.safeParse(identity).success &&
  builderKeySchema.safeParse(repeatableSlotKey(family, identity)).success;

const blockCapabilitiesBase = {
  responsiveVisibility: sourceProvenanceUnchanged(z.boolean()),
  responsiveOrder: sourceProvenanceUnchanged(z.boolean()),
  gridWidth: sourceProvenanceUnchanged(z.boolean()),
  height: sourceProvenanceUnchanged(z.enum(["content", "content_or_bounded"])),
  publicSurface: sourceProvenanceUnchanged(z.enum(["refused", "allowed"])),
};

const blockCapabilitiesSchema = z.discriminatedUnion("accessibleName", [
  z
    .object({
      ...blockCapabilitiesBase,
      accessibleName: sourceProvenanceUnchanged(z.literal("not_applicable")),
    })
    .strict(),
  z
    .object({
      ...blockCapabilitiesBase,
      accessibleName: sourceProvenanceUnchanged(z.enum(["required", "optional"])),
      accessibleNamePropertyPath: sourceProvenanceUnchanged(z.array(builderKeySchema).min(1)),
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
export const customComponentOwnerSchema = z
  .object({
    kind: sourceProvenanceUnchanged(z.enum(["application", "module"])),
    definitionKey: sourceProvenanceUnchanged(namespacedKeySchema),
    releaseVersion: sourceProvenanceUnchanged(semanticVersionSchema),
  })
  .strict();

/** One typed value a custom component event carries. A payload field always declares a type. */
export const customComponentEventPayloadFieldSchema = z
  .object({
    key: sourceProvenanceUnchanged(builderKeySchema),
    label: sourceProvenanceUnchanged(labelSchema),
    type: sourceProvenanceUnchanged(workflowValueTypeSchema),
    required: sourceProvenanceUnchanged(z.boolean()),
  })
  .strict();

/**
 * One declared custom component event. An event carries a typed payload; an undeclared or untyped
 * payload field is refused, because the renderer validates every incoming message against this
 * declaration and drops anything else (it never trusts the component's origin).
 */
export const customComponentEventSchema = z
  .object({
    key: sourceProvenanceUnchanged(builderKeySchema),
    label: sourceProvenanceUnchanged(labelSchema),
    payload: sourceProvenanceUnchanged(z.array(customComponentEventPayloadFieldSchema).max(50)),
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
export const customComponentDataContractSchema = z
  .object({
    values: sourceProvenanceUnchanged(
      z
        .array(
          z
            .object({
              key: sourceProvenanceUnchanged(builderKeySchema),
              label: sourceProvenanceUnchanged(labelSchema),
              type: sourceProvenanceUnchanged(workflowValueTypeSchema),
              required: sourceProvenanceUnchanged(z.boolean()),
            })
            .strict(),
        )
        .max(200),
    ),
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
export const customComponentBundleSchema = z
  .object({
    digest: sourceProvenanceUnchanged(
      z
        .string()
        .regex(/^sha384-[A-Za-z0-9+/]{64}$/, "Use a base64 SHA-384 Subresource Integrity digest"),
    ),
    entryFile: sourceProvenanceUnchanged(customComponentEntryFileSchema),
    allowedHosts: sourceProvenanceUnchanged(z.array(customComponentHostSchema).max(50)),
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
export const customComponentReleaseSchema = z
  .object({
    owner: sourceProvenanceUnchanged(customComponentOwnerSchema),
    events: sourceProvenanceUnchanged(z.array(customComponentEventSchema).max(50)),
    dataContract: sourceProvenanceUnchanged(customComponentDataContractSchema),
    textAlternative: sourceProvenanceUnchanged(labelSchema),
    bundle: sourceProvenanceUnchanged(customComponentBundleSchema),
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

export type CustomComponentOwner = z.infer<typeof customComponentOwnerSchema>;
export type CustomComponentRelease = z.infer<typeof customComponentReleaseSchema>;

/**
 * The context in which one application release places custom components: the placing application's
 * key and the exact module releases it binds. A custom component is placeable only by its owning
 * application, or by an application that binds the owning module release.
 */
export type CustomComponentPlacementContext = Readonly<{
  applicationKey: string;
  boundModuleReleases: readonly Readonly<{ moduleKey: string; releaseVersion: string }>[];
}>;

/**
 * True when the placing application may place the custom component: it is the owning application,
 * or it binds the exact module release that owns it. Any other application is refused, so a custom
 * component never leaks into an unrelated application.
 */
export const customComponentPlacementAllowed = (
  owner: CustomComponentOwner,
  context: CustomComponentPlacementContext,
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
export const containsCustomComponentReleases = (
  releases: readonly Readonly<{ customComponent?: CustomComponentRelease | undefined }>[],
): boolean => releases.some((release) => release.customComponent !== undefined);

/** One immutable, platform-owned block release used by validation and renderer lookup. */
export const platformBlockReleaseSchema = z
  .object({
    blockId: sourceProvenanceUnchanged(blockIdSchema),
    key: sourceProvenanceUnchanged(namespacedKeySchema),
    releaseVersion: sourceProvenanceUnchanged(semanticVersionSchema),
    contentFingerprint: sourceProvenanceUnchanged(fingerprintSchema),
    catalogueFingerprint: sourceProvenanceUnchanged(fingerprintSchema),
    name: sourceProvenanceUnchanged(labelSchema),
    icon: sourceProvenanceUnchanged(iconKeySchema),
    paletteGroup: sourceProvenanceUnchanged(blockPaletteGroupSchema),
    rendererKey: sourceProvenanceUnchanged(namespacedKeySchema),
    properties: sourceProvenanceUnchanged(z.array(blockPropertySchema)),
    slots: sourceProvenanceUnchanged(z.array(blockSlotDeclarationSchema)),
    capabilities: sourceProvenanceUnchanged(blockCapabilitiesSchema),
    /** Semantic events the component emits: the only events a flow binding may name for it. */
    supportedEvents: sourceProvenanceUnchanged(z.array(componentSemanticEventKindSchema)),
    /** State operations a flow may apply to the component. */
    supportedStateOperations: sourceProvenanceUnchanged(z.array(componentStateOperationKindSchema)),
    /**
     * Present only on a custom component release: the owning application or module release, its
     * typed declared events, data contract, text alternative and bundle manifest. A platform block
     * release carries none, and a custom component release carries no built-in semantic events.
     */
    customComponent: sourceProvenanceUnchanged(customComponentReleaseSchema.optional()),
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

export const applicationCompositionPolicySchema = z
  .object({
    maximumDepth: sourceProvenanceUnchanged(z.number().int().positive()),
    maximumPlacements: sourceProvenanceUnchanged(z.number().int().positive()),
  })
  .strict();

export const immutablePlatformBlockCatalogueSchema = z
  .object({
    compositionPolicy: sourceProvenanceUnchanged(applicationCompositionPolicySchema),
    releases: sourceProvenanceUnchanged(z.array(platformBlockReleaseSchema)),
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

export const platformBlockDependencySchema = z
  .object({
    kind: sourceProvenanceUnchanged(z.literal("platform_block")),
    blockId: sourceProvenanceUnchanged(blockIdSchema),
    releaseVersion: sourceProvenanceUnchanged(semanticVersionSchema),
    contentFingerprint: sourceProvenanceUnchanged(fingerprintSchema),
    catalogueFingerprint: sourceProvenanceUnchanged(fingerprintSchema),
  })
  .strict();

export const sourcePlatformBlockDependencySchema = z
  .object({
    kind: sourceProvenanceUnchanged(z.literal("platform_block")),
    block_id: sourceProvenanceTarget(blockIdSchema, ["blockId"]),
    release_version: sourceProvenanceUnchanged(semanticVersionSchema),
    content_fingerprint: sourceProvenanceUnchanged(fingerprintSchema),
    catalogue_fingerprint: sourceProvenanceUnchanged(fingerprintSchema),
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

export const platformBlockDependenciesSchema = z
  .array(platformBlockDependencySchema)
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

export const sourcePlatformBlockDependenciesSchema = z
  .array(sourcePlatformBlockDependencySchema)
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
export const platformBlockReferenceSchema = z
  .object({
    blockId: sourceProvenanceUnchanged(blockIdSchema),
    releaseVersion: sourceProvenanceUnchanged(semanticVersionSchema),
  })
  .strict();

export const sourcePlatformBlockReferenceSchema = z
  .object({
    block_id: sourceProvenanceTarget(blockIdSchema, ["blockId"]),
    release_version: sourceProvenanceUnchanged(semanticVersionSchema),
  })
  .strict();

const widthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: sourceProvenanceUnchanged(z.literal("content")) }).strict(),
  z.object({ kind: sourceProvenanceUnchanged(z.literal("fill")) }).strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("grid")),
      startColumn: sourceProvenanceUnchanged(z.number().int().min(1).max(12)),
      span: sourceProvenanceUnchanged(z.number().int().min(1).max(12)),
    })
    .strict()
    .refine((value) => value.startColumn + value.span <= 13, {
      path: ["span"],
      message: "Placement exceeds the twelve-column grid",
    }),
]);

const sourceWidthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: sourceProvenanceUnchanged(z.literal("content")) }).strict(),
  z.object({ kind: sourceProvenanceUnchanged(z.literal("fill")) }).strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("grid")),
      start_column: sourceProvenanceTarget(z.number().int().min(1).max(12), ["startColumn"]),
      span: sourceProvenanceUnchanged(z.number().int().min(1).max(12)),
    })
    .strict()
    .refine((value) => value.start_column + value.span <= 13, {
      path: ["span"],
      message: "Placement exceeds the twelve-column grid",
    }),
]);

const heightSchema = z.discriminatedUnion("kind", [
  z.object({ kind: sourceProvenanceUnchanged(z.literal("content")) }).strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("bounded")),
      units: sourceProvenanceUnchanged(positiveFiniteSchema),
    })
    .strict(),
]);

export const placementLayoutSchema = z
  .object({
    visible: sourceProvenanceUnchanged(z.boolean()),
    width: sourceProvenanceUnchanged(widthSchema),
    height: sourceProvenanceUnchanged(heightSchema),
  })
  .strict();

export const sourcePlacementLayoutSchema = z
  .object({
    visible: sourceProvenanceUnchanged(z.boolean()),
    width: sourceProvenanceUnchanged(sourceWidthSchema),
    height: sourceProvenanceUnchanged(heightSchema),
  })
  .strict();

export const responsivePlacementSchema = z
  .object({
    desktop: sourceProvenanceUnchanged(placementLayoutSchema),
    tablet: sourceProvenanceUnchanged(placementLayoutSchema),
    phone: sourceProvenanceUnchanged(placementLayoutSchema),
  })
  .strict();

/** Missing authored tablet/phone entries inherit from the next wider breakpoint. */
export const sourceResponsivePlacementSchema = z
  .object({
    desktop: sourceProvenanceUnchanged(sourcePlacementLayoutSchema),
    tablet: sourceProvenanceUnchanged(sourcePlacementLayoutSchema.optional()),
    phone: sourceProvenanceUnchanged(sourcePlacementLayoutSchema.optional()),
  })
  .strict();

export const themeTokenKindSchema = z.enum([
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

export const themeTokenValueSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("color_pair")),
      light: sourceProvenanceUnchanged(colorSchema),
      dark: sourceProvenanceUnchanged(colorSchema),
      role: sourceProvenanceUnchanged(themeColorRoleSchema.optional()),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("typography")),
      family: sourceProvenanceUnchanged(builderKeySchema),
      sizeRem: sourceProvenanceUnchanged(positiveFiniteSchema),
      lineHeight: sourceProvenanceUnchanged(positiveFiniteSchema),
      weight: sourceProvenanceUnchanged(z.number().int().min(100).max(900)),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("spacing")),
      rem: sourceProvenanceUnchanged(nonNegativeFiniteSchema),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("corners")),
      rem: sourceProvenanceUnchanged(nonNegativeFiniteSchema),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("border")),
      widthRem: sourceProvenanceUnchanged(nonNegativeFiniteSchema),
      style: sourceProvenanceUnchanged(z.enum(["solid", "dashed"])),
      colorToken: sourceProvenanceUnchanged(builderKeySchema),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("elevation")),
      level: sourceProvenanceUnchanged(z.number().int().nonnegative()),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("focus")),
      colorToken: sourceProvenanceUnchanged(builderKeySchema),
      widthRem: sourceProvenanceUnchanged(positiveFiniteSchema),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("asset")),
      assetId: sourceProvenanceUnchanged(platformIdSchema),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("density")),
      value: sourceProvenanceUnchanged(z.enum(["compact", "comfortable"])),
    })
    .strict(),
]);

export const sourceThemeTokenValueSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("color_pair")),
      light: sourceProvenanceUnchanged(colorSchema),
      dark: sourceProvenanceUnchanged(colorSchema),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("typography")),
      family: sourceProvenanceUnchanged(builderKeySchema),
      size_rem: sourceProvenanceUnchanged(positiveFiniteSchema),
      line_height: sourceProvenanceUnchanged(positiveFiniteSchema),
      weight: sourceProvenanceUnchanged(z.number().int().min(100).max(900)),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("spacing")),
      rem: sourceProvenanceUnchanged(nonNegativeFiniteSchema),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("corners")),
      rem: sourceProvenanceUnchanged(nonNegativeFiniteSchema),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("border")),
      width_rem: sourceProvenanceUnchanged(nonNegativeFiniteSchema),
      style: sourceProvenanceUnchanged(z.enum(["solid", "dashed"])),
      color_token: sourceProvenanceUnchanged(builderKeySchema),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("elevation")),
      level: sourceProvenanceUnchanged(z.number().int().nonnegative()),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("focus")),
      color_token: sourceProvenanceUnchanged(builderKeySchema),
      width_rem: sourceProvenanceUnchanged(positiveFiniteSchema),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("asset")),
      asset_id: sourceProvenanceUnchanged(platformIdSchema),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("density")),
      value: sourceProvenanceUnchanged(z.enum(["compact", "comfortable"])),
    })
    .strict(),
]);

export const exactPlatformThemeDependencySchema = z
  .object({
    kind: sourceProvenanceUnchanged(z.literal("platform_theme")),
    catalogueThemeId: sourceProvenanceUnchanged(platformIdSchema),
    releaseVersion: sourceProvenanceUnchanged(semanticVersionSchema),
    contentFingerprint: sourceProvenanceUnchanged(fingerprintSchema),
    catalogueFingerprint: sourceProvenanceUnchanged(fingerprintSchema),
  })
  .strict();

export const sourceExactPlatformThemeDependencySchema = z
  .object({
    kind: sourceProvenanceUnchanged(z.literal("platform_theme")),
    catalogue_theme_id: sourceProvenanceUnchanged(platformIdSchema),
    release_version: sourceProvenanceUnchanged(semanticVersionSchema),
    content_fingerprint: sourceProvenanceUnchanged(fingerprintSchema),
    catalogue_fingerprint: sourceProvenanceUnchanged(fingerprintSchema),
  })
  .strict();

/**
 * One option id from the generated shadcn/create theme catalogue
 * (`../catalogue/catalogue/shadcn-create-theme-catalogue.generated.json`). Option ids are
 * lowercase kebab-case, for example `default-translucent`, and are matched against the catalogue
 * exactly.
 */
export const themeCatalogueOptionIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/**
 * One catalogue option id per shadcn/create dimension. A selection is
 * strict: every dimension appears exactly once and no other key is admitted. Runtime/theme
 * resolves the selected options into the complete token set and the style id, refusing an unknown
 * id, a refused option or a missing dimension.
 *
 * The icon library names one of the shadcn/create icon libraries
 * (`../pages/shadcn-icon-libraries.ts`). It is optional so selections recorded before the icon
 * catalogue keep their meaning: an absent icon library is the catalogue default.
 *
 * The body and heading fonts name fonts of the shadcn/create font catalogue
 * (`../theme/shadcn-font-catalogue.ts`); the heading font may also be `inherit`, which paints
 * headings in the body font. They are optional so selections recorded before the font catalogue
 * keep their meaning: an absent font is the catalogue's default.
 */
export const applicationThemeSelectionSchema = z
  .object({
    style: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    baseColor: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    theme: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    chartColor: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    radius: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    menuColor: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    menuAccent: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    iconLibrary: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema.optional()),
    bodyFont: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema.optional()),
    headingFont: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema.optional()),
  })
  .strict();
export type ApplicationThemeSelection = z.infer<typeof applicationThemeSelectionSchema>;

/**
 * The authored form of the catalogue selection, with the snake_case keys every source document
 * uses. Compilation maps it one to one onto the canonical selection above.
 */
export const sourceApplicationThemeSelectionSchema = z
  .object({
    style: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    base_color: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    theme: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    chart_color: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    radius: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    menu_color: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    menu_accent: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    icon_library: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema.optional()),
    body_font: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema.optional()),
    heading_font: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema.optional()),
  })
  .strict();
export type SourceApplicationThemeSelection = z.infer<typeof sourceApplicationThemeSelectionSchema>;

/** Maps an authored selection onto its canonical form. */
export const canonicalApplicationThemeSelection = (
  source: SourceApplicationThemeSelection,
): ApplicationThemeSelection => ({
  style: source.style,
  baseColor: source.base_color,
  theme: source.theme,
  chartColor: source.chart_color,
  radius: source.radius,
  menuColor: source.menu_color,
  menuAccent: source.menu_accent,
  ...(source.icon_library === undefined ? {} : { iconLibrary: source.icon_library }),
  ...(source.body_font === undefined ? {} : { bodyFont: source.body_font }),
  ...(source.heading_font === undefined ? {} : { headingFont: source.heading_font }),
});

/**
 * Canonical  themes contain the complete resolved application token set plus the catalogue
 * selection they were materialised from. Catalogue options are releases of the catalogue's base
 * platform theme release, so a theme pinned to that release always records its effective
 * selection. A theme pinned to an earlier release (for example 2.0.0) records none and keeps that
 * release's exact tokens.
 */
export const applicationThemeSchema = z
  .object({
    base: sourceProvenanceUnchanged(exactPlatformThemeDependencySchema),
    selection: sourceProvenanceUnchanged(applicationThemeSelectionSchema.optional()),
    tokens: sourceProvenanceUnchanged(z.record(builderKeySchema, themeTokenValueSchema)),
  })
  .strict();

/**
 * Authored  themes carry the catalogue selection and may omit overrides; compilation resolves
 * the selection into the full token set. On the catalogue's base release an absent selection means
 * the platform default (nova, neutral base colour, neutral theme); on an earlier release a
 * selection is refused and an absent one keeps that release's exact tokens.
 */
export const sourceApplicationThemeSchema = z
  .object({
    base: sourceProvenanceUnchanged(sourceExactPlatformThemeDependencySchema),
    selection: sourceProvenanceUnchanged(sourceApplicationThemeSelectionSchema.optional()),
    token_overrides: sourceProvenanceUnchanged(
      z.record(builderKeySchema, sourceThemeTokenValueSchema),
    ),
  })
  .strict();

/** Complete immutable platform-theme content needed to materialise one  Application theme. */
export const platformThemeReleaseSchema = z
  .object({
    catalogueThemeId: sourceProvenanceUnchanged(platformIdSchema),
    releaseVersion: sourceProvenanceUnchanged(semanticVersionSchema),
    contentFingerprint: sourceProvenanceUnchanged(fingerprintSchema),
    catalogueFingerprint: sourceProvenanceUnchanged(fingerprintSchema),
    tokens: sourceProvenanceUnchanged(z.record(builderKeySchema, themeTokenValueSchema)),
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
export const platformThemeTokenRoleSchema = z
  .object({
    key: sourceProvenanceUnchanged(builderKeySchema),
    kind: sourceProvenanceUnchanged(themeTokenKindSchema),
    colorRole: sourceProvenanceUnchanged(themeColorRoleSchema.optional()),
  })
  .strict();
export type PlatformThemeTokenRole = z.infer<typeof platformThemeTokenRoleSchema>;

export const platformThemeTokenRoles = [
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
] as const satisfies readonly PlatformThemeTokenRole[];

/** Every token-role key a complete platform theme release must map. */
export type PlatformThemeTokenRoleKey = (typeof platformThemeTokenRoles)[number]["key"];

/**
 * Exact catalogue evidence locked by a trusted caller before pure  compilation.
 * Its fingerprint covers every field except the fingerprint itself.
 */
export const applicationCompositionCatalogueSnapshotSchema = z
  .object({
    contractVersion: sourceProvenanceUnchanged(z.literal("2.0.0")),
    fingerprint: sourceProvenanceUnchanged(fingerprintSchema),
    platformBlocks: sourceProvenanceUnchanged(immutablePlatformBlockCatalogueSchema),
    platformTheme: sourceProvenanceUnchanged(platformThemeReleaseSchema),
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
  "landing_zone_applications",
  "application_role_templates",
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
  landing_zone_applications: Object.freeze({
    label: "Landing Zone applications",
    ownerReader: "unavailable",
    filters: Object.freeze([] as const),
    resultContract: "ProtectedReadModelResolution",
  }),
  application_role_templates: Object.freeze({
    label: "Application role templates",
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
export const protectedReadModelBindingSchema = z
  .object({ key: sourceProvenanceUnchanged(protectedReadModelKeySchema) })
  .strict();
export type ProtectedReadModelBinding = z.infer<typeof protectedReadModelBindingSchema>;

/** Request-time input is closed: a bounded page, the reader's own cursor and the declared filters. */
export const protectedReadModelPageRequestSchema = z
  .object({
    pageSize: sourceProvenanceUnchanged(z.number().int().min(1).max(100)),
    after: sourceProvenanceUnchanged(z.uuid().optional()),
    groupId: sourceProvenanceUnchanged(z.uuid().optional()),
  })
  .strict();
export type ProtectedReadModelPageRequest = z.infer<typeof protectedReadModelPageRequestSchema>;

type BlockPlacement = {
  block: z.infer<typeof platformBlockReferenceSchema>;
  viewPermissionKey?: z.infer<typeof namespacedKeySchema> | undefined;
  usePermissionKey?: z.infer<typeof namespacedKeySchema> | undefined;
  visibilityCondition?: z.infer<typeof conditionNodeSchema> | undefined;
  queryId?: z.infer<typeof queryIdSchema> | undefined;
  readModel?: ProtectedReadModelBinding | undefined;
  settings: Record<string, BlockPropertyValueContract>;
  themeOverrides: Record<string, z.infer<typeof themeTokenValueSchema>>;
  responsive: z.infer<typeof responsivePlacementSchema>;
  slots: Record<string, PlacementSlot>;
};
type PlacementSlot = {
  placements: Record<string, BlockPlacement>;
  order: { desktop: string[]; tablet: string[]; phone: string[] };
};

type SourceBlockPlacement = {
  block: z.infer<typeof sourcePlatformBlockReferenceSchema>;
  view_permission?: z.infer<typeof namespacedKeySchema> | undefined;
  use_permission?: z.infer<typeof namespacedKeySchema> | undefined;
  visibility_condition?: z.infer<typeof sourceQualifiedConditionSchema> | undefined;
  query?: z.infer<typeof builderKeySchema> | undefined;
  read_model?: ProtectedReadModelKey | undefined;
  settings: Record<string, SourceBlockPropertyValueContract>;
  theme_overrides: Record<string, z.infer<typeof sourceThemeTokenValueSchema>>;
  responsive: z.infer<typeof sourceResponsivePlacementSchema>;
  slots: Record<string, SourcePlacementSlot>;
};
type SourcePlacementSlot = {
  placements: Record<string, SourceBlockPlacement>;
  order: { desktop: string[]; tablet?: string[] | undefined; phone?: string[] | undefined };
};

const sameMembers = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length &&
  new Set(actual).size === actual.length &&
  actual.every((entry) => expected.includes(entry));

export const blockPlacementSchema: z.ZodType<BlockPlacement> = z.lazy(() =>
  z
    .object({
      block: sourceProvenanceUnchanged(platformBlockReferenceSchema),
      viewPermissionKey: sourceProvenanceUnchanged(namespacedKeySchema.optional()),
      usePermissionKey: sourceProvenanceUnchanged(namespacedKeySchema.optional()),
      visibilityCondition: sourceProvenanceUnchanged(conditionNodeSchema.optional()),
      queryId: sourceProvenanceUnchanged(queryIdSchema.optional()),
      readModel: sourceProvenanceUnchanged(protectedReadModelBindingSchema.optional()),
      settings: sourceProvenanceUnchanged(z.record(builderKeySchema, blockPropertyValueSchema)),
      themeOverrides: sourceProvenanceUnchanged(z.record(builderKeySchema, themeTokenValueSchema)),
      responsive: sourceProvenanceUnchanged(responsivePlacementSchema),
      slots: sourceProvenanceUnchanged(z.record(builderKeySchema, placementSlotSchema)),
    })
    .strict(),
);

export const placementSlotSchema: z.ZodType<PlacementSlot> = z.lazy(() =>
  z
    .object({
      placements: sourceProvenanceUnchanged(
        z.record(containedComponentIdSchema, blockPlacementSchema),
      ),
      order: sourceProvenanceUnchanged(
        z
          .object({
            desktop: sourceProvenanceUnchanged(z.array(containedComponentIdSchema)),
            tablet: sourceProvenanceUnchanged(z.array(containedComponentIdSchema)),
            phone: sourceProvenanceUnchanged(z.array(containedComponentIdSchema)),
          })
          .strict(),
      ),
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

export const sourceBlockPlacementSchema: z.ZodType<SourceBlockPlacement> = z.lazy(() =>
  z
    .object({
      block: sourceProvenanceUnchanged(sourcePlatformBlockReferenceSchema),
      view_permission: sourceProvenanceTarget(namespacedKeySchema.optional(), [
        "viewPermissionKey",
      ]),
      use_permission: sourceProvenanceTarget(namespacedKeySchema.optional(), ["usePermissionKey"]),
      visibility_condition: sourceProvenanceUnchanged(sourceQualifiedConditionSchema.optional()),
      query: sourceProvenanceTarget(sourceQualifiedQueryReferenceSchema.optional(), ["queryId"]),
      read_model: sourceProvenanceUnchanged(protectedReadModelKeySchema.optional()),
      settings: sourceProvenanceUnchanged(
        z.record(builderKeySchema, sourceBlockPropertyValueSchema),
      ),
      theme_overrides: sourceProvenanceUnchanged(
        z.record(builderKeySchema, sourceThemeTokenValueSchema),
      ),
      responsive: sourceProvenanceUnchanged(sourceResponsivePlacementSchema),
      slots: sourceProvenanceUnchanged(z.record(builderKeySchema, sourcePlacementSlotSchema)),
    })
    .strict(),
);

export const sourcePlacementSlotSchema: z.ZodType<SourcePlacementSlot> = z.lazy(() =>
  z
    .object({
      placements: sourceProvenanceUnchanged(
        z.record(sourceAliasSchema, sourceBlockPlacementSchema),
      ),
      order: sourceProvenanceUnchanged(
        z
          .object({
            desktop: sourceProvenanceUnchanged(
              z.array(
                sourceProvenanceTarget(sourceAliasSchema, [
                  "order/desktop/#",
                  "order/tablet/#",
                  "order/phone/#",
                ]),
              ),
            ),
            tablet: sourceProvenanceUnchanged(
              z
                .array(
                  sourceProvenanceTarget(sourceAliasSchema, ["order/tablet/#", "order/phone/#"]),
                )
                .optional(),
            ),
            phone: sourceProvenanceUnchanged(
              z.array(sourceProvenanceTarget(sourceAliasSchema, ["order/phone/#"])).optional(),
            ),
          })
          .strict(),
      ),
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

export const shellContentSlotSchema = z
  .object({
    slotId: sourceProvenanceUnchanged(containedComponentIdSchema),
    key: sourceProvenanceUnchanged(builderKeySchema),
    label: sourceProvenanceUnchanged(labelSchema),
    required: sourceProvenanceUnchanged(z.boolean()),
    allowedChildCategories: sourceProvenanceUnchanged(z.array(blockPaletteGroupSchema).min(1)),
    parentPlacementId: sourceProvenanceUnchanged(containedComponentIdSchema),
    parentSlotKey: sourceProvenanceUnchanged(builderKeySchema),
  })
  .strict();

export const sourceShellContentSlotSchema = z
  .object({
    id: sourceProvenanceTarget(sourceAliasSchema, ["slotId"]),
    key: sourceProvenanceUnchanged(builderKeySchema),
    label: sourceProvenanceUnchanged(labelSchema),
    required: sourceProvenanceUnchanged(z.boolean()),
    allowed_child_categories: sourceProvenanceUnchanged(z.array(blockPaletteGroupSchema).min(1)),
    parent_placement: sourceProvenanceTarget(sourceAliasSchema, ["parentPlacementId"]),
    parent_slot: sourceProvenanceUnchanged(builderKeySchema),
  })
  .strict();

const applicationShellPresentationSchema = z
  .object({
    sidebar: z
      .object({
        collapsible: z.enum(["none", "icon"]),
        defaultCollapsed: z.boolean(),
      })
      .strict(),
    topBar: z
      .object({
        breadcrumbs: z.boolean(),
        organizationSwitcher: z.boolean(),
        applicationSwitcher: z.boolean(),
        accountMenu: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const applicationPuckRootShellSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }).strict(),
  z
    .object({
      kind: z.literal("application"),
      shellId: sourceProvenanceUnchanged(shellIdSchema),
      key: sourceProvenanceUnchanged(builderKeySchema),
      name: sourceProvenanceUnchanged(labelSchema),
      presentation: sourceProvenanceUnchanged(applicationShellPresentationSchema),
    })
    .strict(),
]);

const sourceApplicationShellPresentationSchema = z
  .object({
    sidebar: sourceProvenanceUnchanged(
      z
        .object({
          collapsible: sourceProvenanceUnchanged(z.enum(["none", "icon"])),
          default_collapsed: sourceProvenanceUnchanged(z.boolean()),
        })
        .strict(),
    ),
    top_bar: sourceProvenanceUnchanged(
      z
        .object({
          breadcrumbs: sourceProvenanceUnchanged(z.boolean()),
          organization_switcher: sourceProvenanceUnchanged(z.boolean()),
          application_switcher: sourceProvenanceUnchanged(z.boolean()),
          account_menu: sourceProvenanceUnchanged(z.boolean()),
        })
        .strict(),
    ),
  })
  .strict();

const collectCanonicalPlacementSlots = (
  slot: PlacementSlot,
  result = new Map<string, Record<string, PlacementSlot>>(),
): Map<string, Record<string, PlacementSlot>> => {
  for (const [placementId, placement] of Object.entries(slot.placements)) {
    result.set(placementId, placement.slots);
    for (const child of Object.values(placement.slots))
      collectCanonicalPlacementSlots(child, result);
  }
  return result;
};

const collectSourcePlacementSlots = (
  slot: SourcePlacementSlot,
  result = new Map<string, Record<string, SourcePlacementSlot>>(),
): Map<string, Record<string, SourcePlacementSlot>> => {
  for (const [placementId, placement] of Object.entries(slot.placements)) {
    result.set(placementId, placement.slots);
    for (const child of Object.values(placement.slots)) collectSourcePlacementSlots(child, result);
  }
  return result;
};

export const canonicalPlacementEntries = (
  slot: PlacementSlot,
  result: [string, BlockPlacement][] = [],
): [string, BlockPlacement][] => {
  for (const [placementId, placement] of Object.entries(slot.placements)) {
    result.push([placementId, placement]);
    for (const child of Object.values(placement.slots)) canonicalPlacementEntries(child, result);
  }
  return result;
};

export const sourcePlacementEntries = (
  slot: SourcePlacementSlot,
  result: [string, SourceBlockPlacement][] = [],
): [string, SourceBlockPlacement][] => {
  for (const [placementId, placement] of Object.entries(slot.placements)) {
    result.push([placementId, placement]);
    for (const child of Object.values(placement.slots)) sourcePlacementEntries(child, result);
  }
  return result;
};

export const applicationShellSchema = z
  .object({
    shellId: sourceProvenanceUnchanged(shellIdSchema),
    key: sourceProvenanceUnchanged(builderKeySchema),
    name: sourceProvenanceUnchanged(labelSchema),
    presentation: sourceProvenanceUnchanged(applicationShellPresentationSchema),
    layout: sourceProvenanceUnchanged(placementSlotSchema),
    contentSlots: sourceProvenanceUnchanged(z.array(shellContentSlotSchema).min(1)),
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

export const sourceApplicationShellSchema = z
  .object({
    id: sourceProvenanceTarget(sourceAliasSchema, ["shellId"]),
    key: sourceProvenanceUnchanged(builderKeySchema),
    name: sourceProvenanceUnchanged(labelSchema),
    presentation: sourceProvenanceUnchanged(sourceApplicationShellPresentationSchema),
    layout: sourceProvenanceUnchanged(sourcePlacementSlotSchema),
    content_slots: sourceProvenanceUnchanged(z.array(sourceShellContentSlotSchema).min(1)),
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

export const pageCompositionSchema = z.discriminatedUnion("shellKind", [
  z
    .object({
      shellKind: sourceProvenanceUnchanged(z.literal("default")),
      main: sourceProvenanceUnchanged(placementSlotSchema),
    })
    .strict(),
  z
    .object({
      shellKind: sourceProvenanceUnchanged(z.literal("application")),
      shellId: sourceProvenanceUnchanged(shellIdSchema),
      content: sourceProvenanceUnchanged(z.record(containedComponentIdSchema, placementSlotSchema)),
    })
    .strict(),
]);

export const sourcePageCompositionSchema = z.discriminatedUnion("shell_kind", [
  z
    .object({
      shell_kind: sourceProvenanceUnchanged(z.literal("default")),
      main: sourceProvenanceUnchanged(sourcePlacementSlotSchema),
    })
    .strict(),
  z
    .object({
      shell_kind: sourceProvenanceUnchanged(z.literal("application")),
      shell: sourceProvenanceTarget(sourceAliasSchema, ["shellId"]),
      content: sourceProvenanceUnchanged(z.record(sourceAliasSchema, sourcePlacementSlotSchema)),
    })
    .strict(),
]);

/** One page shell with an exact, separately ordered content tree for every guided step. */
export const guidedFormPageCompositionSchema = z.discriminatedUnion("shellKind", [
  z
    .object({
      shellKind: sourceProvenanceUnchanged(z.literal("default")),
      stepContent: sourceProvenanceUnchanged(
        z.record(containedComponentIdSchema, placementSlotSchema),
      ),
    })
    .strict(),
  z
    .object({
      shellKind: sourceProvenanceUnchanged(z.literal("application")),
      shellId: sourceProvenanceUnchanged(shellIdSchema),
      stepContent: sourceProvenanceUnchanged(
        z.record(
          containedComponentIdSchema,
          z.record(containedComponentIdSchema, placementSlotSchema),
        ),
      ),
    })
    .strict(),
]);

export const sourceGuidedFormPageCompositionSchema = z.discriminatedUnion("shell_kind", [
  z
    .object({
      shell_kind: sourceProvenanceUnchanged(z.literal("default")),
      step_content: sourceProvenanceUnchanged(
        z.record(sourceAliasSchema, sourcePlacementSlotSchema),
      ),
    })
    .strict(),
  z
    .object({
      shell_kind: sourceProvenanceUnchanged(z.literal("application")),
      shell: sourceProvenanceTarget(sourceAliasSchema, ["shellId"]),
      step_content: sourceProvenanceUnchanged(
        z.record(sourceAliasSchema, z.record(sourceAliasSchema, sourcePlacementSlotSchema)),
      ),
    })
    .strict(),
]);

export type PlatformBlockRelease = z.infer<typeof platformBlockReleaseSchema>;
export type ComponentStateOperationKind = z.infer<typeof componentStateOperationKindSchema>;
export type PlatformThemeRelease = z.infer<typeof platformThemeReleaseSchema>;
export type ApplicationCompositionPolicy = z.infer<typeof applicationCompositionPolicySchema>;
export type ImmutablePlatformBlockCatalogue = z.infer<typeof immutablePlatformBlockCatalogueSchema>;
export type ApplicationCompositionCatalogueSnapshot = z.infer<
  typeof applicationCompositionCatalogueSnapshotSchema
>;
export type BlockPlacementContract = z.infer<typeof blockPlacementSchema>;
export type ApplicationShell = z.infer<typeof applicationShellSchema>;
export type ApplicationPuckRootShell = z.infer<typeof applicationPuckRootShellSchema>;
export type PageComposition = z.infer<typeof pageCompositionSchema>;
export type GuidedFormPageComposition = z.infer<typeof guidedFormPageCompositionSchema>;

/** The compiled composition one renderer input carries: dependencies, shells, pages and theme. */
export const materialisedApplicationCompositionSchema = z
  .object({
    platformBlockDependencies: platformBlockDependenciesSchema,
    shells: z.array(applicationShellSchema),
    pages: z.array(
      z
        .object({
          pageId: z.string().min(1),
          composition: z.union([pageCompositionSchema, guidedFormPageCompositionSchema]),
          steps: z
            .array(
              z.object({ id: z.string().min(1), name: z.string(), summary: z.boolean() }).strict(),
            )
            .optional(),
        })
        .strict(),
    ),
    theme: applicationThemeSchema,
  })
  .strict();

/*
 * Studio discovery projection. It republishes the declarations of one immutable platform block
 * catalogue, the same catalogue save and publish validation judge, so Studio offers only what that
 * catalogue declares and a new catalogue release needs no separate Studio allowlist. The catalogue
 * declares no per-release semantic events yet; the only operations projected are the placement
 * layout operations validation enforces from each release's capabilities.
 */

/** Property kinds whose value names an application-scoped or stored target. */
export const blockReferencePropertyKinds = [
  "field_reference",
  "relationship_reference",
  "action_reference",
  "page_reference",
  "query_reference",
  "pipeline_reference",
  "record_type_reference",
  "record_reference",
  "asset_reference",
] as const satisfies readonly BlockPropertySchemaContract["kind"][];
export type BlockReferencePropertyKind = (typeof blockReferencePropertyKinds)[number];

const blockReferencePropertyKindSet: ReadonlySet<string> = new Set(blockReferencePropertyKinds);

export const isBlockReferencePropertyKind = (
  kind: BlockPropertySchemaContract["kind"],
): kind is BlockReferencePropertyKind => blockReferencePropertyKindSet.has(kind);

/** A public page admits only releases whose capabilities allow the public surface. */
export type CompositionSurface = "authenticated" | "public";

/** Exact release identity and palette metadata; its fingerprints fill a dependency manifest. */
export type PlatformBlockReleaseSummary = Readonly<
  Pick<
    PlatformBlockRelease,
    | "blockId"
    | "key"
    | "releaseVersion"
    | "contentFingerprint"
    | "catalogueFingerprint"
    | "name"
    | "icon"
    | "paletteGroup"
    | "rendererKey"
  > & { publicSurface: PlatformBlockRelease["capabilities"]["publicSurface"] }
>;

export type ComponentPropertyControl = Readonly<{
  /** The exact catalogue declaration, including every constraint validation applies to it. */
  declaration: BlockPropertySchemaContract;
  /** Validation refuses the placement when the author leaves this value unset. */
  valueRequired: boolean;
  /** This text property supplies the component's accessible name. */
  accessibleName: boolean;
  referenceKind?: BlockReferencePropertyKind;
  /** Controls of a group declaration, in declaration order. */
  properties?: readonly ComponentPropertyControl[];
  /** Control for each item of a list declaration. */
  item?: ComponentPropertyControl;
}>;

/** Placement layout choices; content width, fill width and content height are always available. */
export type ComponentLayoutOperations = Readonly<{
  /** Visibility may differ between desktop, tablet and phone. */
  responsiveVisibility: boolean;
  /** Placements inside this component's slots may use a different order per breakpoint. */
  responsiveChildOrder: boolean;
  /** Width may use a twelve-column grid span. */
  gridWidth: boolean;
  /** Height may be bounded. */
  boundedHeight: boolean;
}>;

export type ComponentDiscoverySlot = Readonly<{
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
  allowedChildren: readonly PlatformBlockReleaseSummary[];
}>;

export type ComponentDiscovery = Readonly<{
  release: PlatformBlockReleaseSummary;
  /** Semantic events a flow binding may name for this release, as the catalogue declares them. */
  supportedEvents: readonly ComponentSemanticEventKind[];
  /** State operations a flow may apply to this release, as the catalogue declares them. */
  supportedStateOperations: readonly ComponentStateOperationKind[];
  accessibleName: PlatformBlockRelease["capabilities"]["accessibleName"];
  properties: readonly ComponentPropertyControl[];
  /** Distinct reference kinds declared anywhere in the component's properties. */
  referenceKinds: readonly BlockReferencePropertyKind[];
  slots: readonly ComponentDiscoverySlot[];
  layoutOperations: ComponentLayoutOperations;
}>;

export type PlatformCatalogueDiscovery = Readonly<{
  surface: CompositionSurface;
  compositionPolicy: ApplicationCompositionPolicy;
  /** Every release offered on the surface, in catalogue order. */
  components: readonly ComponentDiscovery[];
  /** Keyed by platformBlockReleaseIdentity, the exact identity a placement names. */
  componentsByRelease: ReadonlyMap<string, ComponentDiscovery>;
}>;

export const platformBlockReleaseIdentity = (
  block: Readonly<{ blockId: string; releaseVersion: string }>,
): string => `${block.blockId}:${block.releaseVersion}`;

const summarisePlatformBlockRelease = (
  release: PlatformBlockRelease,
): PlatformBlockReleaseSummary =>
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
const projectPropertyControls = (
  declarations: readonly BlockPropertySchemaContract[],
  namePath: readonly string[] | undefined,
  nameRequired: boolean,
): readonly ComponentPropertyControl[] =>
  Object.freeze(
    declarations.map((declaration): ComponentPropertyControl => {
      const rest =
        namePath !== undefined && namePath[0] === declaration.key ? namePath.slice(1) : undefined;
      const nameValueRequired =
        rest !== undefined && nameRequired && declaration.defaultValue === undefined;
      return Object.freeze({
        declaration,
        valueRequired:
          (declaration.required && declaration.defaultValue === undefined) || nameValueRequired,
        accessibleName: rest !== undefined && rest.length === 0,
        ...(isBlockReferencePropertyKind(declaration.kind)
          ? { referenceKind: declaration.kind }
          : {}),
        ...(declaration.kind === "group"
          ? {
              properties: projectPropertyControls(
                declaration.properties,
                rest !== undefined && rest.length > 0 ? rest : undefined,
                nameValueRequired,
              ),
            }
          : {}),
        ...(declaration.kind === "list"
          ? { item: projectPropertyControls([declaration.item], undefined, false)[0]! }
          : {}),
      });
    }),
  );

const collectReferenceKinds = (
  controls: readonly ComponentPropertyControl[],
  kinds: Set<BlockReferencePropertyKind>,
): Set<BlockReferencePropertyKind> => {
  for (const control of controls) {
    if (control.referenceKind !== undefined) kinds.add(control.referenceKind);
    if (control.properties !== undefined) collectReferenceKinds(control.properties, kinds);
    if (control.item !== undefined) collectReferenceKinds([control.item], kinds);
  }
  return kinds;
};

/** Projects the releases, property controls, slot children and layout operations of one surface. */
export const projectPlatformCatalogueDiscovery = (
  catalogue: ImmutablePlatformBlockCatalogue,
  surface: CompositionSurface = "authenticated",
): PlatformCatalogueDiscovery => {
  const offered = catalogue.releases.filter(
    (release) => surface === "authenticated" || release.capabilities.publicSurface === "allowed",
  );
  const summaries = offered.map(summarisePlatformBlockRelease);
  const components = Object.freeze(
    offered.map((release, index): ComponentDiscovery => {
      const capabilities = release.capabilities;
      const properties = projectPropertyControls(
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
        referenceKinds: Object.freeze([...collectReferenceKinds(properties, new Set())]),
        slots: Object.freeze(
          release.slots.map((slot): ComponentDiscoverySlot => {
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
      components.map((component) => [platformBlockReleaseIdentity(component.release), component]),
    ),
  });
};
