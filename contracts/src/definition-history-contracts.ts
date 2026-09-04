import { z } from "zod";
import { correlationIdSchema } from "./common";
import {
  actorIdSchema,
  applicationRootIdSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationIdSchema,
  revisionSchema,
  timestampSchema,
} from "./identifiers";
import { stableDefinitionReleaseVersionSchema } from "./version-impact";

const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);

const definitionHistoryCommandCommon = {
  pageSize: z.number().int().min(1).max(100),
  beforeReleaseRevision: javascriptSafeRevisionSchema.optional(),
};

/**
 * A bounded, newest-first page of immutable Definition-release metadata.
 * The root discriminator prevents a Module command from addressing an Application root.
 */
export const definitionReleaseHistoryCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("module"),
      rootId: moduleRootIdSchema,
      ...definitionHistoryCommandCommon,
    })
    .strict(),
  z
    .object({
      kind: z.literal("application"),
      rootId: applicationRootIdSchema,
      ...definitionHistoryCommandCommon,
    })
    .strict(),
]);

/** A strict request for one immutable history entry's safe metadata. */
export const definitionReleaseMetadataCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("module"),
      rootId: moduleRootIdSchema,
      releaseRevision: javascriptSafeRevisionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("application"),
      rootId: applicationRootIdSchema,
      releaseRevision: javascriptSafeRevisionSchema,
    })
    .strict(),
]);

/**
 * The request restores only an immutable release selected by permanent root and revision.
 * Source, actor, timestamp, identity evidence and provenance are server-owned.
 */
export const restoreDefinitionDraftCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("module"),
      rootId: moduleRootIdSchema,
      targetReleaseRevision: javascriptSafeRevisionSchema,
      expectedDraftRevision: javascriptSafeRevisionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("application"),
      rootId: applicationRootIdSchema,
      targetReleaseRevision: javascriptSafeRevisionSchema,
      expectedDraftRevision: javascriptSafeRevisionSchema,
    })
    .strict(),
]);

/** The only metadata exposed by history listing and exact-release inspection. */
export const definitionReleaseMetadataSchema = z
  .object({
    releaseRevision: javascriptSafeRevisionSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
    sourceFingerprint: fingerprintSchema,
    contentFingerprint: fingerprintSchema,
    releaseNote: z
      .string()
      .min(1)
      .max(2_000)
      .refine((value) => value === value.trim(), "Release notes must not have outer whitespace"),
    publishedAt: timestampSchema,
    publishedBy: actorIdSchema,
    isCurrent: z.boolean(),
  })
  .strict();

const definitionReleaseHistoryResultCommon = {
  organizationId: organizationIdSchema,
  definitionKey: namespacedKeySchema,
  currentReleaseRevision: javascriptSafeRevisionSchema.optional(),
  entries: z.array(definitionReleaseMetadataSchema).max(100),
  nextBeforeReleaseRevision: javascriptSafeRevisionSchema.optional(),
  correlationId: correlationIdSchema,
};

/**
 * A page has strictly descending release revisions. A continuation, when supplied,
 * anchors the next page immediately before the last returned revision.
 */
export const definitionReleaseHistoryResultSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("module"),
        rootId: moduleRootIdSchema,
        ...definitionReleaseHistoryResultCommon,
      })
      .strict(),
    z
      .object({
        kind: z.literal("application"),
        rootId: applicationRootIdSchema,
        ...definitionReleaseHistoryResultCommon,
      })
      .strict(),
  ])
  .superRefine((result, context) => {
    if (
      result.entries.some(
        (entry, index) =>
          index > 0 && result.entries[index - 1]!.releaseRevision <= entry.releaseRevision,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Definition release history entries must be newest first without duplicates",
      });

    if (result.entries.filter((entry) => entry.isCurrent).length > 1)
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "A definition release history page cannot contain more than one current entry",
      });

    if (
      result.entries.some(
        (entry) => entry.isCurrent !== (entry.releaseRevision === result.currentReleaseRevision),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["currentReleaseRevision"],
        message: "The current release revision must match the current history entry",
      });

    if (result.nextBeforeReleaseRevision !== undefined) {
      const lastEntry = result.entries.at(-1);
      if (lastEntry === undefined || result.nextBeforeReleaseRevision !== lastEntry.releaseRevision)
        context.addIssue({
          code: "custom",
          path: ["nextBeforeReleaseRevision"],
          message: "A history continuation must be the last returned release revision",
        });
    }
  });

const definitionReleaseMetadataResultCommon = {
  organizationId: organizationIdSchema,
  definitionKey: namespacedKeySchema,
  currentReleaseRevision: javascriptSafeRevisionSchema.optional(),
  metadata: definitionReleaseMetadataSchema,
  correlationId: correlationIdSchema,
};

/** The strict safe projection for one exact immutable Definition release. */
export const definitionReleaseMetadataResultSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("module"),
        rootId: moduleRootIdSchema,
        ...definitionReleaseMetadataResultCommon,
      })
      .strict(),
    z
      .object({
        kind: z.literal("application"),
        rootId: applicationRootIdSchema,
        ...definitionReleaseMetadataResultCommon,
      })
      .strict(),
  ])
  .superRefine((result, context) => {
    if (
      result.metadata.isCurrent !==
      (result.currentReleaseRevision === result.metadata.releaseRevision)
    )
      context.addIssue({
        code: "custom",
        path: ["currentReleaseRevision"],
        message: "The current release revision must match current metadata",
      });
  });

export type DefinitionReleaseHistoryCommand = z.infer<typeof definitionReleaseHistoryCommandSchema>;
export type DefinitionReleaseMetadataCommand = z.infer<
  typeof definitionReleaseMetadataCommandSchema
>;
export type RestoreDefinitionDraftCommand = z.infer<typeof restoreDefinitionDraftCommandSchema>;
export type DefinitionReleaseMetadata = z.infer<typeof definitionReleaseMetadataSchema>;
export type DefinitionReleaseHistoryResult = z.infer<typeof definitionReleaseHistoryResultSchema>;
export type DefinitionReleaseMetadataResult = z.infer<typeof definitionReleaseMetadataResultSchema>;
