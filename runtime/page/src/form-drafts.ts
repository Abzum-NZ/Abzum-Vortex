import "server-only";

import { z } from "zod";
import {
  applicationRootIdSchema,
  containedComponentIdSchema,
  fieldIdSchema,
  identityIdSchema,
  jsonValueSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  platformIdSchema,
  recordIdSchema,
  revisionSchema,
  ruleIdSchema,
  timestampSchema,
  workflowNodeIdSchema,
} from "@vortex/contracts";

/**
 * #587: Page-owned private revisioned form drafts.
 *
 * A draft is one person's unfinished input for one exact form of one exact
 * installed application release. It is deliberately not a business record: it
 * creates no Record, Activity or event, and it disappears after thirty days
 * untouched. The store is private to the person, so the same draft can only be
 * read back by the organisation account that wrote it, while the browser and an
 * authorised MCP client share the one revision-checked contract.
 *
 * Values and validation state are stored as bounded JSON keyed by permanent
 * field identity. A read never returns the stored document directly: the
 * repository projects it through the exact fields and choices the page layer
 * currently permits, so a stale or unpermitted field never reaches a caller.
 */

/** An untouched draft is removed thirty days after its last revision. */
export const privateFormDraftRetentionDays = 30 as const;

/** Bounds that keep one draft a bounded personal scratch document. */
export const privateFormDraftLimits = Object.freeze({
  fields: 500,
  serializedBytes: 262_144,
  choicesPerField: 1_000,
});

/**
 * One field's safe validation state. Only a closed state and a bounded machine
 * reason code are stored, never a rendered message or raw server value.
 */
export const privateFormDraftFieldValidationSchema = z
  .object({
    state: z.enum(["valid", "invalid", "incomplete"]),
    reasonCode: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z][a-z0-9_]*$/)
      .optional(),
  })
  .strict();

export type PrivateFormDraftFieldValidation = z.infer<
  typeof privateFormDraftFieldValidationSchema
>;

const boundedFieldValueRecordSchema = z
  .record(fieldIdSchema, jsonValueSchema)
  .superRefine((value, context) => {
    if (Object.keys(value).length > privateFormDraftLimits.fields)
      context.addIssue({
        code: "custom",
        message: "A draft carries at most the bounded number of fields",
      });
    if (JSON.stringify(value).length > privateFormDraftLimits.serializedBytes)
      context.addIssue({ code: "custom", message: "A draft value set is too large" });
  });

export const privateFormDraftValidationSchema = z
  .record(fieldIdSchema, privateFormDraftFieldValidationSchema)
  .superRefine((value, context) => {
    if (Object.keys(value).length > privateFormDraftLimits.fields)
      context.addIssue({
        code: "custom",
        message: "A draft carries validation state for at most the bounded number of fields",
      });
  });

/** The exact identity of one unfinished form, before any value is stored. */
const privateFormDraftScopeShape = {
  formId: containedComponentIdSchema,
  flowId: ruleIdSchema.optional(),
  nodeId: workflowNodeIdSchema.optional(),
  subjectRecordId: recordIdSchema.optional(),
};

export const privateFormDraftSchema = z
  .object({
    draftId: platformIdSchema,
    organizationId: organizationIdSchema,
    organizationAccountId: organizationAccountIdSchema,
    identityId: identityIdSchema,
    applicationRootId: applicationRootIdSchema,
    installationReleaseRevision: revisionSchema,
    ...privateFormDraftScopeShape,
    revision: revisionSchema,
    values: z.record(fieldIdSchema, jsonValueSchema),
    validation: privateFormDraftValidationSchema,
    state: z.enum(["active", "abandoned", "expired"]),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict();

export type PrivateFormDraft = z.infer<typeof privateFormDraftSchema>;

/**
 * The server-owned projection a read applies before returning values. The page
 * layer derives it from current field and choice permissions; a caller never
 * widens it, so a value outside these fields is dropped rather than returned.
 */
export const privateFormDraftProjectionSchema = z
  .object({
    permittedFieldIds: z.array(fieldIdSchema).max(privateFormDraftLimits.fields),
    fieldChoices: z
      .record(fieldIdSchema, z.array(jsonValueSchema).min(1).max(privateFormDraftLimits.choicesPerField))
      .optional(),
  })
  .strict();

export type PrivateFormDraftProjection = z.infer<typeof privateFormDraftProjectionSchema>;

const privateFormDraftScopeCommandSchema = z.object(privateFormDraftScopeShape).strict();

export const createPrivateFormDraftCommandSchema = privateFormDraftScopeCommandSchema
  .extend({
    values: boundedFieldValueRecordSchema,
    validation: privateFormDraftValidationSchema,
  })
  .strict();

export const readPrivateFormDraftCommandSchema = privateFormDraftScopeCommandSchema
  .extend({ projection: privateFormDraftProjectionSchema })
  .strict();

export const updatePrivateFormDraftCommandSchema = privateFormDraftScopeCommandSchema
  .extend({
    draftId: platformIdSchema,
    expectedRevision: revisionSchema,
    values: boundedFieldValueRecordSchema,
    validation: privateFormDraftValidationSchema,
  })
  .strict();

export const abandonPrivateFormDraftCommandSchema = z
  .object({ draftId: platformIdSchema, expectedRevision: revisionSchema })
  .strict();

export type CreatePrivateFormDraftCommand = z.infer<typeof createPrivateFormDraftCommandSchema>;
export type ReadPrivateFormDraftCommand = z.infer<typeof readPrivateFormDraftCommandSchema>;
export type UpdatePrivateFormDraftCommand = z.infer<typeof updatePrivateFormDraftCommandSchema>;
export type AbandonPrivateFormDraftCommand = z.infer<typeof abandonPrivateFormDraftCommandSchema>;

export type PrivateFormDraftCreateResult =
  | Readonly<{ outcome: "created"; draft: PrivateFormDraft }>
  | Readonly<{ outcome: "exists" }>
  | Readonly<{ outcome: "unavailable" }>;

export type PrivateFormDraftReadResult =
  | Readonly<{ outcome: "available"; draft: PrivateFormDraft }>
  | Readonly<{ outcome: "stale_installation" }>
  | Readonly<{ outcome: "unavailable" }>;

export type PrivateFormDraftUpdateResult =
  | Readonly<{ outcome: "updated"; draft: PrivateFormDraft }>
  | Readonly<{ outcome: "stale_revision" }>
  | Readonly<{ outcome: "stale_installation" }>
  | Readonly<{ outcome: "unavailable" }>;

export type PrivateFormDraftAbandonResult =
  | Readonly<{ outcome: "abandoned"; draft: PrivateFormDraft }>
  | Readonly<{ outcome: "stale_revision" }>
  | Readonly<{ outcome: "unavailable" }>;

export const privateFormDraftErrorCodes = [
  "INVALID_PRIVATE_FORM_DRAFT_COMMAND",
  "INVALID_PRIVATE_FORM_DRAFT_STORAGE_RESULT",
  "PRIVATE_FORM_DRAFT_SCOPE_UNAVAILABLE",
  "PRIVATE_FORM_DRAFT_ALREADY_EXISTS",
  "PRIVATE_FORM_DRAFT_REVISION_STALE",
  "PRIVATE_FORM_DRAFT_INSTALLATION_STALE",
  "PRIVATE_FORM_DRAFT_OPERATION_FAILED",
] as const;

export type PrivateFormDraftErrorCode = (typeof privateFormDraftErrorCodes)[number];

export class PrivateFormDraftError extends Error {
  readonly code: PrivateFormDraftErrorCode;

  constructor(code: PrivateFormDraftErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "PrivateFormDraftError";
    this.code = code;
  }
}

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const filterChoices = (
  value: unknown,
  choices: readonly unknown[],
): Readonly<{ keep: boolean; value: unknown }> =>
  Array.isArray(value)
    ? { keep: true, value: value.filter((part) => choices.some((c) => sameJson(c, part))) }
    : choices.some((choice) => sameJson(choice, value))
      ? { keep: true, value }
      : { keep: false, value: undefined };

/**
 * Projects one stored draft to the exact currently permitted fields, choices
 * and validation state. This is the only shape a caller ever receives: an
 * unpermitted field is omitted, a value outside a permitted choice list is
 * dropped, and validation for an omitted field is left out too.
 */
export const projectPrivateFormDraft = (
  draft: PrivateFormDraft,
  projectionCandidate: PrivateFormDraftProjection,
): PrivateFormDraft => {
  const projection = privateFormDraftProjectionSchema.parse(projectionCandidate);
  const permitted = new Set(projection.permittedFieldIds.map((id) => id.toLowerCase()));
  const choicesByField = new Map(
    Object.entries(projection.fieldChoices ?? {}).map(
      ([fieldId, choices]) => [fieldId.toLowerCase(), choices] as const,
    ),
  );

  const values: Record<string, unknown> = {};
  for (const [fieldId, value] of Object.entries(draft.values)) {
    if (!permitted.has(fieldId.toLowerCase())) continue;
    const choices = choicesByField.get(fieldId.toLowerCase());
    const projected = choices === undefined ? { keep: true, value } : filterChoices(value, choices);
    if (!projected.keep) continue;
    values[fieldId] = projected.value;
  }

  const validation = Object.fromEntries(
    Object.entries(draft.validation).filter(([fieldId]) => permitted.has(fieldId.toLowerCase())),
  );

  return {
    ...draft,
    values: values as unknown as PrivateFormDraft["values"],
    validation: validation as unknown as PrivateFormDraft["validation"],
  };
};
