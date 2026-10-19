import { z } from "zod";
import { correlationIdSchema, jsonValueSchema } from "../catalogue/common";
import {
  actorIdSchema,
  applicationRootIdSchema,
  eventOccurrenceIdSchema,
  fieldIdSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  organizationIdSchema,
  platformIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  semanticVersionSchema,
  timestampSchema,
} from "../catalogue/identifiers";
import { installedEventDescriptorSchema } from "../definition/module-foundation-contracts";
import type { StandardInstalledEventKind } from "../definition/module-foundation-contracts";

const eventOccurrenceDefinitionReleaseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("application"),
      rootId: applicationRootIdSchema,
      releaseRevision: revisionSchema,
      releaseVersion: semanticVersionSchema,
      contentFingerprint: fingerprintSchema,
      resolutionFingerprint: fingerprintSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("module"),
      rootId: moduleRootIdSchema,
      releaseRevision: revisionSchema,
      releaseVersion: semanticVersionSchema,
      contentFingerprint: fingerprintSchema,
      resolutionFingerprint: fingerprintSchema,
    })
    .strict(),
]);

const canonicalFieldIdsSchema = z
  .array(fieldIdSchema)
  .min(1)
  .max(500)
  .superRefine((fieldIds, context) => {
    if (new Set(fieldIds).size !== fieldIds.length)
      context.addIssue({ code: "custom", message: "Field identities must be unique" });
    if (fieldIds.some((fieldId, index) => index > 0 && fieldIds[index - 1]! >= fieldId))
      context.addIssue({ code: "custom", message: "Field identities must use canonical order" });
  });

const emptyStandardOccurrencePayload = (
  kind: Exclude<StandardInstalledEventKind, "changed" | "state_changed">,
) => z.object({ kind: z.literal(kind) }).strict();

const standardEventOccurrencePayloadSchema = z.discriminatedUnion("kind", [
  emptyStandardOccurrencePayload("created"),
  z.object({ kind: z.literal("changed"), changedFieldIds: canonicalFieldIdsSchema }).strict(),
  emptyStandardOccurrencePayload("deleted"),
  emptyStandardOccurrencePayload("linked"),
  emptyStandardOccurrencePayload("unlinked"),
  emptyStandardOccurrencePayload("reassigned"),
  z
    .object({
      kind: z.literal("state_changed"),
      fieldId: fieldIdSchema,
      previousValue: jsonValueSchema.optional(),
      newValue: jsonValueSchema.optional(),
    })
    .strict(),
]);

const declaredEventOccurrencePayloadSchema = z
  .object({ kind: z.literal("declared"), carriedValues: z.record(fieldIdSchema, jsonValueSchema) })
  .strict();

/**
 * Versioned occurrence data. It preserves the historical V1 envelope and keeps
 * the occurrence identity distinct from the reusable declaration identity.
 * Definition-backed payload privacy and field-type checks are intentionally
 * performed by Event using Record's field semantics, not claimed by this shape alone.
 */
export const eventOccurrenceEnvelopeSchema = z
  .object({
    contractVersion: z.literal("2.0.0"),
    occurrenceId: eventOccurrenceIdSchema,
    organizationId: organizationIdSchema,
    installation: z
      .object({
        applicationRootId: applicationRootIdSchema,
        applicationReleaseRevision: revisionSchema,
        moduleBinding: z
          .object({
            moduleRootId: moduleRootIdSchema,
            moduleReleaseRevision: revisionSchema,
            bindingRevision: revisionSchema,
          })
          .strict(),
      })
      .strict(),
    descriptor: installedEventDescriptorSchema,
    definitionRelease: eventOccurrenceDefinitionReleaseSchema,
    recordId: recordIdSchema,
    occurredAt: timestampSchema,
    actorId: actorIdSchema,
    correlationId: correlationIdSchema,
    causationId: platformIdSchema.optional(),
    recordSequence: revisionSchema,
    payload: z.union([standardEventOccurrencePayloadSchema, declaredEventOccurrencePayloadSchema]),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedPayloadKind =
      value.descriptor.kind === "standard" ? value.descriptor.eventKind : "declared";
    if (value.payload.kind !== expectedPayloadKind)
      context.addIssue({
        code: "custom",
        path: ["payload", "kind"],
        message: "Occurrence payload kind must match its installed event descriptor",
      });
    if (value.descriptor.kind === "declared") {
      const ownerRootId =
        value.descriptor.owner.kind === "application"
          ? value.descriptor.owner.applicationRootId
          : value.descriptor.owner.moduleRootId;
      if (
        value.definitionRelease.kind !== value.descriptor.owner.kind ||
        value.definitionRelease.rootId !== ownerRootId
      )
        context.addIssue({
          code: "custom",
          path: ["definitionRelease"],
          message: "Declared occurrence release must match its declaration owner",
        });
      if (
        (value.descriptor.owner.kind === "application" &&
          value.installation.applicationRootId !== value.descriptor.owner.applicationRootId) ||
        (value.descriptor.owner.kind === "module" &&
          value.installation.moduleBinding.moduleRootId !== value.descriptor.owner.moduleRootId)
      )
        context.addIssue({
          code: "custom",
          path: ["installation"],
          message: "Declared occurrence installation must contain its declaration owner",
        });
    } else if (
      value.definitionRelease.kind !== "module" ||
      value.definitionRelease.rootId !== value.installation.moduleBinding.moduleRootId
    )
      context.addIssue({
        code: "custom",
        path: ["definitionRelease"],
        message: "A standard occurrence belongs to its record type's Module release",
      });
  });

/** Installation work shares the durable outbox and delivery protocol with record events. */
export const installationActivatedOccurrenceSchema = z
  .object({
    kind: z.literal("installation_activated"),
    occurrenceId: eventOccurrenceIdSchema,
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
    occurredAt: timestampSchema,
  })
  .strict();

export const dispatchOccurrenceSchema = z.union([
  eventOccurrenceEnvelopeSchema,
  installationActivatedOccurrenceSchema,
]);
export type DispatchOccurrence = z.infer<typeof dispatchOccurrenceSchema>;

export const liveInvalidationSchema = z
  .object({
    contractVersion: semanticVersionSchema,
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    recordTypeId: recordTypeIdSchema,
    recordId: recordIdSchema.optional(),
    changeKind: z.enum(["created", "changed", "deleted", "restored", "access_changed"]),
    dataVersion: revisionSchema,
    recordVersion: revisionSchema.optional(),
    sequence: revisionSchema,
    occurredAt: timestampSchema,
    correlationId: correlationIdSchema,
  })
  .strict();

export type EventOccurrenceEnvelope = z.infer<typeof eventOccurrenceEnvelopeSchema>;

export type LiveInvalidation = z.infer<typeof liveInvalidationSchema>;
