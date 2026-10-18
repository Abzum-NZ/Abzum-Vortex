import { z } from "zod";
import { labelSchema, safeHttpsUrlSchema } from "../../catalogue/common";
import {
  sourceProvenanceUnchanged,
  sourceQualifiedFieldSchema,
  sourceQualifiedQueryReferenceSchema,
  sourceQualifiedRelationshipSchema,
} from "../definition-source-common";
import {
  builderKeySchema,
  namespacedKeySchema,
  platformIdSchema,
  sourceQualifiedRecordTypeSchema,
} from "../../catalogue/identifiers";
import {
  richTextDocumentSchema,
  richTextElementKindSchema,
  type RichTextInline,
} from "../../records/rich-text";
import type { DefinitionRuleFailureFamily } from "../../catalogue/validation-errors";
import {
  type BlockPropertyValueContract,
  blockPropertyValueSchema,
  type SourceBlockPropertyValueContract,
} from "./block-property-values";

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
  /** Show this control only for the declared choices of a sibling setting. */
  showWhen?: { property: string; values: string[] } | undefined;
  defaultValue?: BlockPropertyValueContract | undefined;
  /** This declaration contains display content whose edits may keep a patch version. */
  presentation?: true | undefined;
  /** Stable property of a presentation list's group item, when entries have identities. */
  presentationIdentity?: string | undefined;
  /**
   * Present only on the `field_reference` property an automatic field input binds its record field
   * to: the compiler then derives that input's name, label, requirement, choices and control from
   * the referenced module field, each a setting the release declares among its derived properties.
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
      kind:
        | "field_reference"
        | "relationship_reference"
        | "action_reference"
        | "page_reference"
        | "query_reference"
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
  showWhen: sourceProvenanceUnchanged(
    z
      .object({
        property: builderKeySchema,
        values: z.array(z.string().min(1)).min(1),
      })
      .strict()
      .optional(),
  ),
  defaultValue: sourceProvenanceUnchanged(blockPropertyValueSchema.optional()),
  presentation: sourceProvenanceUnchanged(z.literal(true).optional()),
  presentationIdentity: sourceProvenanceUnchanged(builderKeySchema.optional()),
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

const plainObject = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const plainStringOf = (schema: z.ZodType<string>, value: unknown): string | undefined => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

/**
 * Reads one authored setting value as the typed value of the release property it fills.
 *
 * Authored settings are plain JSON placed directly on an item's props: a string, number, boolean,
 * rich-text document, `{record_type, record_id}` record reference, an object for a group and an
 * array for a list. The release property declaration alone gives the value its kind, so an authored
 * value never repeats it. Shape mismatches are reported as `invalid_value` at their setting path and
 * undeclared group keys as `unknown_property` (or `unsafe_content`); every other rule is judged by
 * `validateComponentSettingValue` on the typed result.
 */
export const typedSourceSettingValue = (
  value: unknown,
  declaration: BlockPropertySchemaContract,
  path: readonly (string | number)[],
  failures: ComponentSettingFailure[],
): SourceBlockPropertyValueContract | undefined => {
  const invalid = (): undefined => {
    failures.push({ family: "invalid_value", path });
    return undefined;
  };
  const text = (schema: z.ZodType<string>): string | undefined =>
    plainStringOf(schema, value) ?? invalid();
  switch (declaration.kind) {
    case "text":
    case "url":
    case "choice": {
      const parsed = text(declaration.kind === "url" ? safeHttpsUrlSchema : z.string());
      return parsed === undefined ? undefined : { kind: declaration.kind, value: parsed };
    }
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? { kind: "number", value }
        : invalid();
    case "boolean":
      return typeof value === "boolean" ? { kind: "boolean", value } : invalid();
    case "rich_text": {
      const parsed = richTextDocumentSchema.safeParse(value);
      return parsed.success ? { kind: "rich_text", value: parsed.data } : invalid();
    }
    case "asset_reference": {
      const parsed = text(platformIdSchema);
      return parsed === undefined
        ? undefined
        : { kind: "asset_reference", asset_id: parsed as never };
    }
    case "icon": {
      const parsed = text(builderKeySchema);
      return parsed === undefined ? undefined : { kind: "icon", icon_key: parsed };
    }
    case "field_reference": {
      const parsed = text(sourceQualifiedFieldSchema);
      return parsed === undefined ? undefined : { kind: "field_reference", field: parsed };
    }
    case "relationship_reference": {
      const parsed = text(sourceQualifiedRelationshipSchema);
      return parsed === undefined
        ? undefined
        : { kind: "relationship_reference", relationship: parsed };
    }
    case "action_reference": {
      const parsed = text(namespacedKeySchema);
      return parsed === undefined ? undefined : { kind: "action_reference", action: parsed };
    }
    case "page_reference": {
      const parsed = text(builderKeySchema);
      return parsed === undefined ? undefined : { kind: "page_reference", page: parsed };
    }
    case "query_reference": {
      const parsed = text(sourceQualifiedQueryReferenceSchema);
      return parsed === undefined ? undefined : { kind: "query_reference", query: parsed };
    }
    case "record_type_reference": {
      const parsed = text(sourceQualifiedRecordTypeSchema);
      return parsed === undefined
        ? undefined
        : { kind: "record_type_reference", record_type: parsed };
    }
    case "record_reference": {
      const reference = plainObject(value);
      const recordType = plainStringOf(sourceQualifiedRecordTypeSchema, reference?.record_type);
      const recordId = plainStringOf(z.uuid(), reference?.record_id);
      if (
        reference === undefined ||
        Object.keys(reference).some((key) => key !== "record_type" && key !== "record_id") ||
        recordType === undefined ||
        recordId === undefined
      )
        return invalid();
      return { kind: "record_reference", record_type: recordType, record_id: recordId };
    }
    case "group": {
      const group = plainObject(value);
      if (group === undefined) return invalid();
      const declared = new Map(declaration.properties.map((property) => [property.key, property]));
      const properties: Record<string, SourceBlockPropertyValueContract> = {};
      let complete = true;
      for (const [key, nested] of Object.entries(group)) {
        const property = declared.get(key);
        if (property === undefined) {
          failures.push({
            family: isExecutableComponentSettingKey(key) ? "unsafe_content" : "unknown_property",
            path: [...path, key],
          });
          complete = false;
          continue;
        }
        const typed = typedSourceSettingValue(nested, property, [...path, key], failures);
        if (typed === undefined) complete = false;
        else properties[key] = typed;
      }
      return complete ? { kind: "group", properties } : undefined;
    }
    case "list": {
      if (!Array.isArray(value)) return invalid();
      const items: SourceBlockPropertyValueContract[] = [];
      let complete = true;
      value.forEach((item: unknown, index) => {
        const typed = typedSourceSettingValue(item, declaration.item, [...path, index], failures);
        if (typed === undefined) complete = false;
        else items.push(typed);
      });
      return complete ? { kind: "list", items } : undefined;
    }
  }
};

/**
 * Reads an item's authored settings against its release declarations. Returns the typed settings
 * and every failure: undeclared keys, plain values of the wrong shape and every rule
 * `validateComponentSettingValue` judges, including a missing required value.
 */
export const typedSourceSettings = (
  settings: Readonly<Record<string, unknown>>,
  declarations: readonly BlockPropertySchemaContract[],
): Readonly<{
  settings: Record<string, SourceBlockPropertyValueContract>;
  failures: ComponentSettingFailure[];
}> => {
  const failures: ComponentSettingFailure[] = [];
  const typed: Record<string, SourceBlockPropertyValueContract> = {};
  const declared = new Set(declarations.map((declaration) => declaration.key));
  for (const key of Object.keys(settings))
    if (!declared.has(key))
      failures.push({
        family: isExecutableComponentSettingKey(key) ? "unsafe_content" : "unknown_property",
        path: [key],
      });
  for (const declaration of declarations) {
    if (!Object.hasOwn(settings, declaration.key)) {
      if (declaration.required && declaration.defaultValue === undefined)
        failures.push({ family: "required_value", path: [declaration.key] });
      continue;
    }
    const value = typedSourceSettingValue(
      settings[declaration.key],
      declaration,
      [declaration.key],
      failures,
    );
    if (value === undefined) continue;
    typed[declaration.key] = value;
    failures.push(...validateComponentSettingValue(value, declaration, [declaration.key]));
  }
  return { settings: typed, failures };
};

/** The plain authored form of one typed setting value: the value without its kind. */
export const plainSourceSettingValue = (value: SourceBlockPropertyValueContract): unknown => {
  switch (value.kind) {
    case "asset_reference":
      return value.asset_id;
    case "icon":
      return value.icon_key;
    case "field_reference":
      return value.field;
    case "relationship_reference":
      return value.relationship;
    case "action_reference":
      return value.action;
    case "page_reference":
      return value.page;
    case "query_reference":
      return value.query;
    case "record_type_reference":
      return value.record_type;
    case "record_reference":
      return { record_type: value.record_type, record_id: value.record_id };
    case "group":
      return Object.fromEntries(
        Object.entries(value.properties).map(([key, nested]) => [
          key,
          plainSourceSettingValue(nested),
        ]),
      );
    case "list":
      return value.items.map(plainSourceSettingValue);
    default:
      return value.value;
  }
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
const typedSettingCandidate = (
  value: unknown,
  declaration: BlockPropertySchemaContract,
): unknown => {
  switch (declaration.kind) {
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
      const reference = plainObject(value);
      return reference === undefined ? undefined : { kind: declaration.kind, ...reference };
    }
    case "group": {
      const group = plainObject(value);
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

/**
 * Reads one plain compiled setting value as the canonical value of the declaration it fills, or
 * undefined when it is not one. The declaration alone gives the value its kind, and the value must
 * satisfy every constraint of that declaration (options, bounds, item shapes).
 */
export const typedSettingValue = (
  value: unknown,
  declaration: BlockPropertySchemaContract,
): BlockPropertyValueContract | undefined => {
  const parsed = blockPropertyValueSchema.safeParse(typedSettingCandidate(value, declaration));
  if (!parsed.success) return undefined;
  return validateComponentSettingValue(parsed.data, declaration).length === 0
    ? parsed.data
    : undefined;
};

/** Kinds naming application-scoped authority, which a platform-owned default cannot choose. */
const authorityReferenceKinds: ReadonlySet<string> = new Set([
  "field_reference",
  "relationship_reference",
  "action_reference",
  "page_reference",
  "query_reference",
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

export type BlockPropertyVisibilityIssue = Readonly<{
  path: [number, ...(string | number)[]];
  message: string;
}>;

/**
 * Visibility conditions must refer to an earlier sibling choice and one or more of its options.
 * The editor clears hidden settings in declaration order, so this also keeps chained conditions
 * deterministic and prevents a malformed reference from hiding a control and deleting its value.
 */
export const blockPropertyVisibilityIssues = (
  properties: readonly BlockPropertySchemaContract[],
): readonly BlockPropertyVisibilityIssue[] => {
  const issues: BlockPropertyVisibilityIssue[] = [];
  const extendPath = (
    path: BlockPropertyVisibilityIssue["path"],
    ...parts: (string | number)[]
  ): BlockPropertyVisibilityIssue["path"] => [path[0], ...path.slice(1), ...parts];
  function inspect(
    declarations: readonly BlockPropertySchemaContract[],
    prefix?: BlockPropertyVisibilityIssue["path"],
  ): void {
    for (const [index, property] of declarations.entries()) {
      const path: BlockPropertyVisibilityIssue["path"] =
        prefix === undefined ? [index] : extendPath(prefix, index);
      const condition = property.showWhen;
      if (condition !== undefined) {
        const controllingIndex = declarations.findIndex(
          (candidate) => candidate.key === condition.property,
        );
        const controller = declarations[controllingIndex];
        if (controller === undefined) {
          issues.push({
            path: extendPath(path, "showWhen", "property"),
            message: "A visibility condition must name a sibling choice property",
          });
        } else if (controller.kind !== "choice") {
          issues.push({
            path: extendPath(path, "showWhen", "property"),
            message: "A visibility condition must name a sibling choice property",
          });
        } else {
          if (controllingIndex >= index)
            issues.push({
              path: extendPath(path, "showWhen", "property"),
              message: "A visibility condition must use an earlier sibling choice property",
            });
          const optionKeys = new Set(controller.options.map((option) => option.key));
          if (
            new Set(condition.values).size !== condition.values.length ||
            condition.values.some((value) => !optionKeys.has(value))
          )
            issues.push({
              path: extendPath(path, "showWhen", "values"),
              message: "Visibility values must be unique options of the sibling choice property",
            });
        }
      }

      if (property.kind === "group") {
        inspect(property.properties, extendPath(path, "properties"));
      } else if (property.kind === "list") {
        inspectListItem(property.item, extendPath(path, "item"));
      }
    }
  }
  function inspectListItem(
    item: BlockPropertySchemaContract,
    path: BlockPropertyVisibilityIssue["path"],
  ): void {
    if (item.showWhen !== undefined)
      issues.push({
        path: extendPath(path, "showWhen"),
        message: "A list item cannot have a visibility condition",
      });
    if (item.kind === "group") inspect(item.properties, extendPath(path, "properties"));
    else if (item.kind === "list") inspectListItem(item.item, extendPath(path, "item"));
  }
  inspect(properties);
  return issues;
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
          kind: sourceProvenanceUnchanged(
            z.enum([
              "field_reference",
              "relationship_reference",
              "action_reference",
              "page_reference",
              "query_reference",
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
      if (value.presentationIdentity !== undefined) {
        const identity =
          value.kind === "list" && value.item.kind === "group"
            ? value.item.properties.find((property) => property.key === value.presentationIdentity)
            : undefined;
        if (
          value.presentation !== true ||
          identity === undefined ||
          !identity.required ||
          (identity.kind !== "text" && identity.kind !== "field_reference")
        )
          context.addIssue({
            code: "custom",
            path: ["presentationIdentity"],
            message:
              "A presentation identity must name a text or field reference in a presentation list's group item",
          });
      }
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
