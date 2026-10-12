import "server-only";

import { z } from "zod";
import {
  applicationRootIdSchema,
  builderKeySchema,
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
  type JsonValue,
} from "@vortex/contracts";

/**
 * #587: Page-owned private revisioned form drafts.
 *
 * A draft is one person's unfinished input for one exact form of one exact
 * installed application release. It is deliberately not a business record: it
 * creates no Record, Activity or event, and it is removed thirty days after its
 * last revision. The store is private to the person, so a draft can only be read
 * back by the organisation account that wrote it, while the browser and an
 * authorised MCP client share the one revision-checked contract.
 *
 * Values and validation state are stored as bounded JSON keyed by permanent
 * field identity or by the form's declared input key. Both are written and read
 * only through the server-owned projection of the fields and choices the page
 * layer currently permits, so an unpermitted or write-only field is never stored
 * and a stale field or choice never reaches a caller.
 */

/** An untouched draft is removed thirty days after its last revision. */
export const privateFormDraftRetentionDays = 30 as const;

/** Bounds that keep one draft a bounded personal scratch document. */
export const privateFormDraftLimits = Object.freeze({
  fields: 500,
  serializedBytes: 262_144,
  choicesPerField: 1_000,
});

/** A permanent field identity, or a record-free form input key. Field identities are lower case. */
export const privateFormDraftInputKeySchema = z
  .string()
  .refine(
    (key) => fieldIdSchema.safeParse(key).success || builderKeySchema.safeParse(key).success,
    { message: "A draft key is a permanent field identity or a declared form input key" },
  );

const normalizedKey = (key: string): string => key.toLowerCase();

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

const serializedBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

const privateFormDraftValuesSchema = z
  .record(privateFormDraftInputKeySchema, jsonValueSchema)
  .superRefine((value, context) => {
    if (Object.keys(value).length > privateFormDraftLimits.fields)
      context.addIssue({
        code: "custom",
        message: "A draft carries at most the bounded number of fields",
      });
    if (serializedBytes(value) > privateFormDraftLimits.serializedBytes)
      context.addIssue({ code: "custom", message: "A draft value set is too large" });
  });

export const privateFormDraftValidationSchema = z
  .record(privateFormDraftInputKeySchema, privateFormDraftFieldValidationSchema)
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

export const privateFormDraftScopeSchema = z.object(privateFormDraftScopeShape).strict();

export type PrivateFormDraftScope = z.infer<typeof privateFormDraftScopeSchema>;

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
    values: z.record(privateFormDraftInputKeySchema, jsonValueSchema),
    validation: privateFormDraftValidationSchema,
    state: z.enum(["active", "abandoned"]),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict();

export type PrivateFormDraft = z.infer<typeof privateFormDraftSchema>;

/**
 * The server-owned projection of one exact installed form: the fields the
 * current person may fill and read back now, and the choices each choice field
 * currently allows. It is derived on the server for every operation and is never
 * part of a caller's command. A write-only (secret) field is not listed, so its
 * value is neither stored in the draft nor returned.
 */
export const privateFormDraftProjectionSchema = z
  .object({
    permittedFieldIds: z.array(privateFormDraftInputKeySchema).max(privateFormDraftLimits.fields),
    fieldChoices: z
      .record(
        privateFormDraftInputKeySchema,
        z.array(jsonValueSchema).min(1).max(privateFormDraftLimits.choicesPerField),
      )
      .optional(),
  })
  .strict();

export type PrivateFormDraftProjection = z.infer<typeof privateFormDraftProjectionSchema>;

export const createPrivateFormDraftCommandSchema = privateFormDraftScopeSchema
  .extend({
    values: privateFormDraftValuesSchema,
    validation: privateFormDraftValidationSchema,
  })
  .strict();

export const readPrivateFormDraftCommandSchema = privateFormDraftScopeSchema;

export const updatePrivateFormDraftCommandSchema = privateFormDraftScopeSchema
  .extend({
    draftId: platformIdSchema,
    expectedRevision: revisionSchema,
    values: privateFormDraftValuesSchema,
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

type ProjectedField = Readonly<{ keep: boolean; changed: boolean; value: JsonValue }>;

const projectField = (value: JsonValue, choices: readonly JsonValue[] | undefined): ProjectedField => {
  if (choices === undefined) return { keep: true, changed: false, value };
  if (Array.isArray(value)) {
    const allowed = value.filter((part) => choices.some((choice) => sameJson(choice, part)));
    return { keep: true, changed: allowed.length !== value.length, value: allowed };
  }
  return choices.some((choice) => sameJson(choice, value))
    ? { keep: true, changed: false, value }
    : { keep: false, changed: true, value };
};

/**
 * Restricts one value set and its validation state to the exact permitted
 * fields and choices. An unpermitted field is omitted, a value outside a
 * permitted choice list is dropped, and validation is kept only for a permitted
 * field whose value the projection left unchanged, so a stale "valid" state
 * never describes a value the caller no longer sees. Keys come back normalised.
 */
export const restrictPrivateFormDraftInput = (
  input: Readonly<{
    values: Readonly<Record<string, JsonValue>>;
    validation: Readonly<Record<string, PrivateFormDraftFieldValidation>>;
  }>,
  projectionCandidate: PrivateFormDraftProjection,
): Readonly<{
  values: Record<string, JsonValue>;
  validation: Record<string, PrivateFormDraftFieldValidation>;
}> => {
  const parsed = privateFormDraftProjectionSchema.safeParse(projectionCandidate);
  if (!parsed.success)
    throw new PrivateFormDraftError("PRIVATE_FORM_DRAFT_OPERATION_FAILED", { cause: parsed.error });
  const projection = parsed.data;
  const permitted = new Set(projection.permittedFieldIds.map(normalizedKey));
  const choicesByField = new Map(
    Object.entries(projection.fieldChoices ?? {}).map(
      ([fieldId, choices]) => [normalizedKey(fieldId), choices] as const,
    ),
  );

  const values: Record<string, JsonValue> = {};
  const changed = new Set<string>();
  for (const [fieldId, value] of Object.entries(input.values)) {
    const key = normalizedKey(fieldId);
    if (!permitted.has(key)) continue;
    const projected = projectField(value, choicesByField.get(key));
    if (projected.changed) changed.add(key);
    if (projected.keep) values[key] = projected.value;
  }

  const validation: Record<string, PrivateFormDraftFieldValidation> = {};
  for (const [fieldId, state] of Object.entries(input.validation)) {
    const key = normalizedKey(fieldId);
    if (permitted.has(key) && !changed.has(key)) validation[key] = state;
  }
  return { values, validation };
};

/**
 * Projects one stored draft to the exact currently permitted fields, choices
 * and validation state. This is the only shape a caller ever receives.
 */
export const projectPrivateFormDraft = (
  draft: PrivateFormDraft,
  projection: PrivateFormDraftProjection,
): PrivateFormDraft => {
  const restricted = restrictPrivateFormDraftInput(draft, projection);
  return {
    ...draft,
    values: restricted.values as PrivateFormDraft["values"],
    validation: restricted.validation as PrivateFormDraft["validation"],
  };
};
