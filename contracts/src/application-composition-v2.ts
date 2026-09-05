import { z } from "zod";
import { blockPaletteGroupSchema } from "./catalogues";
import { labelSchema, safeHttpsUrlSchema } from "./common";
import {
  sourceAliasSchema,
  sourceQualifiedFieldSchema,
  sourceQualifiedRecordTypeSchema,
  sourceQualifiedRelationshipSchema,
} from "./definition-source-common";
import { recordTypeReferenceSchema } from "./definitions";
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

const iconKeySchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const nonNegativeFiniteSchema = z.number().finite().nonnegative();
const positiveFiniteSchema = z.number().finite().positive();

export const richTextElementKindV2Schema = z.enum([
  "paragraph",
  "heading",
  "bulleted_list",
  "numbered_list",
  "emphasis",
  "link",
]);

type RichTextInlineV2 =
  | { kind: "text"; text: string }
  | { kind: "emphasis"; style: "strong" | "emphasis" | "code"; children: RichTextInlineV2[] }
  | { kind: "link"; address: string; children: RichTextInlineV2[] };

const richTextInlineV2Schema: z.ZodType<RichTextInlineV2> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), text: z.string() }).strict(),
    z
      .object({
        kind: z.literal("emphasis"),
        style: z.enum(["strong", "emphasis", "code"]),
        children: z.array(richTextInlineV2Schema).min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal("link"),
        address: safeHttpsUrlSchema,
        children: z.array(richTextInlineV2Schema).min(1),
      })
      .strict(),
  ]),
);

export const richTextBlockV2Schema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("paragraph"), children: z.array(richTextInlineV2Schema).min(1) })
    .strict(),
  z
    .object({
      kind: z.literal("heading"),
      level: z.enum(["2", "3", "4"]),
      children: z.array(richTextInlineV2Schema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["bulleted_list", "numbered_list"]),
      items: z.array(z.array(richTextInlineV2Schema).min(1)).min(1),
    })
    .strict(),
]);

export const richTextDocumentV2Schema = z
  .object({ blocks: z.array(richTextBlockV2Schema) })
  .strict();

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
  | { kind: "query_reference"; query: z.infer<typeof builderKeySchema> }
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
      z.object({ kind: z.literal("query_reference"), query: builderKeySchema }).strict(),
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

type BlockPropertySchemaV2Base = {
  key: string;
  label: string;
  help?: string | undefined;
  required: boolean;
  defaultValue?: BlockPropertyValueV2Contract | undefined;
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
};

const richTextKinds = (document: z.infer<typeof richTextDocumentV2Schema>): Set<string> => {
  const kinds = new Set<string>();
  const visitInline = (inline: RichTextInlineV2): void => {
    if (inline.kind === "text") return;
    kinds.add(inline.kind);
    for (const child of inline.children) visitInline(child);
  };
  for (const block of document.blocks) {
    kinds.add(block.kind);
    if (block.kind === "paragraph" || block.kind === "heading")
      for (const child of block.children) visitInline(child);
    else for (const item of block.items) for (const child of item) visitInline(child);
  }
  return kinds;
};

const defaultMatchesProperty = (schema: BlockPropertySchemaV2Contract): boolean => {
  const value = schema.defaultValue;
  if (value === undefined) return true;
  if (value.kind !== schema.kind) return false;
  switch (schema.kind) {
    case "text": {
      const text = (value as { value: string }).value;
      return text.length >= schema.minLength && text.length <= schema.maxLength;
    }
    case "number": {
      const number = (value as { value: number }).value;
      return (
        (schema.minimum === undefined || number >= schema.minimum) &&
        (schema.maximum === undefined || number <= schema.maximum) &&
        (!schema.integer || Number.isInteger(number))
      );
    }
    case "choice":
      return schema.options.some((option) => option.key === (value as { value: string }).value);
    case "rich_text": {
      const allowed = new Set<string>(schema.allowedElements);
      return [
        ...richTextKinds((value as { value: z.infer<typeof richTextDocumentV2Schema> }).value),
      ].every((kind) => allowed.has(kind));
    }
    case "group": {
      const properties = schema.properties;
      const values = (value as { properties: Record<string, BlockPropertyValueV2Contract> })
        .properties;
      if (Object.keys(values).some((key) => !properties.some((property) => property.key === key)))
        return false;
      return properties.every((property) => {
        const nested = values[property.key];
        return nested === undefined
          ? !property.required && property.defaultValue === undefined
          : defaultMatchesProperty({ ...property, defaultValue: nested });
      });
    }
    case "list": {
      const items = (value as { items: BlockPropertyValueV2Contract[] }).items;
      return (
        items.length >= schema.minimumItems &&
        items.length <= schema.maximumItems &&
        items.every((item) => defaultMatchesProperty({ ...schema.item, defaultValue: item }))
      );
    }
    case "field_reference":
    case "relationship_reference":
    case "action_reference":
    case "page_reference":
    case "query_reference":
    case "pipeline_reference":
    case "record_type_reference":
    case "record_reference":
      // Platform-owned registrations cannot choose an application-scoped authority reference.
      return false;
    default:
      return true;
  }
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
    }),
);

export const blockSlotDeclarationV2Schema = z
  .object({
    key: builderKeySchema,
    label: labelSchema,
    required: z.boolean(),
    allowedChildCategories: z.array(blockPaletteGroupSchema).min(1),
  })
  .strict();

const blockCapabilitiesV2Schema = z
  .object({
    responsiveVisibility: z.boolean(),
    responsiveOrder: z.boolean(),
    gridWidth: z.boolean(),
    height: z.enum(["content", "content_or_bounded"]),
    accessibleName: z.enum(["required", "optional", "not_applicable"]),
    publicSurface: z.enum(["refused", "allowed"]),
  })
  .strict();

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
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.properties.map((property) => property.key)).size !== value.properties.length)
      context.addIssue({
        code: "custom",
        path: ["properties"],
        message: "Property keys must be unique",
      });
    if (new Set(value.slots.map((slot) => slot.key)).size !== value.slots.length)
      context.addIssue({ code: "custom", path: ["slots"], message: "Slot keys must be unique" });
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

const deterministicDependencyList = <Entry extends { blockId: string }>(
  entries: Entry[],
): boolean =>
  entries.every(
    (entry, index) => index === 0 || String(entries[index - 1]!.blockId) < String(entry.blockId),
  );

export const platformBlockDependenciesV2Schema = z
  .array(platformBlockDependencyV2Schema)
  .superRefine((entries, context) => {
    if (new Set(entries.map((entry) => entry.blockId)).size !== entries.length)
      context.addIssue({
        code: "custom",
        message: "One exact release is allowed per platform block",
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
    const normalized = entries.map((entry) => ({ ...entry, blockId: String(entry.block_id) }));
    if (new Set(normalized.map((entry) => entry.blockId)).size !== entries.length)
      context.addIssue({
        code: "custom",
        message: "One exact release is allowed per platform block",
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

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const themeTokenValueV2Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("color_pair"), light: colorSchema, dark: colorSchema }).strict(),
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

/** Canonical V2 themes contain the complete resolved application token set. */
export const applicationThemeV2Schema = z
  .object({
    base: exactPlatformThemeDependencyV2Schema,
    tokens: z.record(builderKeySchema, themeTokenValueV2Schema),
  })
  .strict();

/** Authored V2 themes may omit overrides; compilation materialises the full token set. */
export const sourceApplicationThemeV2Schema = z
  .object({
    base: sourceExactPlatformThemeDependencyV2Schema,
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
    const blockIds = value.platformBlocks.releases.map((release) => String(release.blockId));
    if (new Set(blockIds).size !== blockIds.length)
      context.addIssue({
        code: "custom",
        path: ["platformBlocks", "releases"],
        message: "A compile snapshot may contain only one exact release per platform block",
      });
    if (blockIds.some((blockId, index) => index > 0 && blockIds[index - 1]! >= blockId))
      context.addIssue({
        code: "custom",
        path: ["platformBlocks", "releases"],
        message: "Compile snapshot block releases must use permanent-identity order",
      });
  });

type BlockPlacementV2 = {
  block: z.infer<typeof platformBlockReferenceV2Schema>;
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

export type PlatformBlockReleaseV2 = z.infer<typeof platformBlockReleaseV2Schema>;
export type PlatformBlockDependencyV2 = z.infer<typeof platformBlockDependencyV2Schema>;
export type PlatformThemeReleaseV2 = z.infer<typeof platformThemeReleaseV2Schema>;
export type ApplicationCompositionPolicyV2 = z.infer<typeof applicationCompositionPolicyV2Schema>;
export type ApplicationCompositionCatalogueSnapshotV2 = z.infer<
  typeof applicationCompositionCatalogueSnapshotV2Schema
>;
export type BlockPlacementV2Contract = z.infer<typeof blockPlacementV2Schema>;
export type ApplicationShellV2 = z.infer<typeof applicationShellV2Schema>;
export type PageCompositionV2 = z.infer<typeof pageCompositionV2Schema>;
