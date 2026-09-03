import { z } from "zod";
import { applicationSourceDocumentSchema, moduleSourceDocumentSchema } from "./definition-source";
import {
  actorIdSchema,
  applicationRootIdSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationIdSchema,
  platformIdSchema,
  revisionSchema,
  semanticVersionSchema,
  timestampSchema,
} from "./identifiers";

const storedDefinitionSourceSchema = z.discriminatedUnion("kind", [
  moduleSourceDocumentSchema,
  applicationSourceDocumentSchema,
]);
const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);

export const createDefinitionRootCommandSchema = z
  .object({ source: storedDefinitionSourceSchema })
  .strict();

export const saveDefinitionDraftCommandSchema = z
  .object({
    rootId: platformIdSchema,
    expectedDraftRevision: javascriptSafeRevisionSchema,
    source: storedDefinitionSourceSchema,
  })
  .strict();

const storedDraftMetadata = {
  organizationId: organizationIdSchema,
  key: namespacedKeySchema,
  draftRevision: javascriptSafeRevisionSchema,
  publishedRevision: javascriptSafeRevisionSchema.optional(),
  sourceContractVersion: semanticVersionSchema,
  sourceFingerprint: fingerprintSchema,
  createdAt: timestampSchema,
  createdBy: actorIdSchema,
  updatedAt: timestampSchema,
  updatedBy: actorIdSchema,
};

export const storedDefinitionDraftSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("module"),
      rootId: moduleRootIdSchema,
      source: moduleSourceDocumentSchema,
      ...storedDraftMetadata,
    })
    .strict(),
  z
    .object({
      kind: z.literal("application"),
      rootId: applicationRootIdSchema,
      source: applicationSourceDocumentSchema,
      ...storedDraftMetadata,
    })
    .strict(),
]);

export type CreateDefinitionRootCommand = z.infer<typeof createDefinitionRootCommandSchema>;
export type SaveDefinitionDraftCommand = z.infer<typeof saveDefinitionDraftCommandSchema>;
export type StoredDefinitionDraft = z.infer<typeof storedDefinitionDraftSchema>;
