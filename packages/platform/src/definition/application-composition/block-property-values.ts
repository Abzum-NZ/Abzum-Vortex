import { z } from "zod";
import { safeHttpsUrlSchema } from "../../catalogue/common";
import type {
  sourceQualifiedFieldSchema,
  sourceQualifiedQueryReferenceSchema,
  sourceQualifiedRelationshipSchema,
} from "../definition-source-common";
import { sourceProvenanceUnchanged } from "../definition-source-common";
import { recordTypeReferenceSchema } from "../definitions";
import {
  builderKeySchema,
  containedComponentIdSchema,
  fieldIdSchema,
  namespacedKeySchema,
  pageIdSchema,
  pipelineIdSchema,
  platformIdSchema,
  queryIdSchema,
  recordIdSchema,
} from "../../catalogue/identifiers";
import type { sourceQualifiedRecordTypeSchema } from "../../catalogue/identifiers";
import { richTextDocumentSchema } from "../../records/rich-text";

export { richTextDocumentSchema, richTextElementKindSchema } from "../../records/rich-text";

export type BlockPropertyValueContract =
  | { kind: "text"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "choice"; value: string }
  | { kind: "rich_text"; value: z.infer<typeof richTextDocumentSchema> }
  | { kind: "url"; value: string }
  | { kind: "asset_reference"; assetId: z.infer<typeof platformIdSchema> }
  | { kind: "icon"; iconKey: string }
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

/**
 * The typed reading of one authored setting value. Authored settings are stored plain (see
 * `typedSourceSettingValue`); the declaration they fill gives them this kind, and they keep their
 * portable aliases until compilation resolves them to the canonical form above.
 */
export type SourceBlockPropertyValueContract =
  | { kind: "text"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "choice"; value: string }
  | { kind: "rich_text"; value: z.infer<typeof richTextDocumentSchema> }
  | { kind: "url"; value: string }
  | { kind: "asset_reference"; asset_id: z.infer<typeof platformIdSchema> }
  | { kind: "icon"; icon_key: string }
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
