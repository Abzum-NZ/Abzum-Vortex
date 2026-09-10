import { z } from "zod";
import {
  directShareIdSchema,
  fieldIdSchema,
  groupIdSchema,
  organizationAccountIdSchema,
  recordIdSchema,
  revisionSchema,
  timestampSchema,
} from "./identifiers";

const canonicalFieldIdsSchema = z.array(fieldIdSchema).superRefine((values, context) => {
  const normalized = values.map((value) => value.toLowerCase());
  if (
    new Set(normalized).size !== normalized.length ||
    normalized.some((value, index) => index > 0 && normalized[index - 1]! >= value)
  )
    context.addIssue({
      code: "custom",
      message: "Field identifiers must be unique and canonically ordered",
    });
});

export const grantOrganizationDirectRecordShareCommandSchema = z
  .object({
    recordId: recordIdSchema,
    recipient: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("organization_account"),
          organizationAccountId: organizationAccountIdSchema,
        })
        .strict(),
      z.object({ kind: z.literal("group"), groupId: groupIdSchema }).strict(),
    ]),
    readableFieldIds: canonicalFieldIdsSchema.min(1),
    changeableFieldIds: canonicalFieldIdsSchema,
    startsAt: timestampSchema,
    expiresAt: timestampSchema.optional(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    const readable = new Set(value.readableFieldIds.map((fieldId) => fieldId.toLowerCase()));
    if (value.changeableFieldIds.some((fieldId) => !readable.has(fieldId.toLowerCase())))
      context.addIssue({
        code: "custom",
        path: ["changeableFieldIds"],
        message: "Changeable fields must also be readable",
      });
    if (value.expiresAt !== undefined && Date.parse(value.expiresAt) <= Date.parse(value.startsAt))
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "A direct share must expire after it starts",
      });
  });

export const revokeOrganizationDirectRecordShareCommandSchema = z
  .object({
    directShareId: directShareIdSchema,
    recordId: recordIdSchema,
    expectedRevision: revisionSchema,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const changeOrganizationDirectRecordShareResultSchema = z
  .object({
    directShareId: directShareIdSchema,
    revision: revisionSchema,
    state: z.enum(["active", "revoked"]),
    changedAt: timestampSchema,
    accessVersion: revisionSchema,
  })
  .strict();

export type GrantOrganizationDirectRecordShareCommand = z.infer<
  typeof grantOrganizationDirectRecordShareCommandSchema
>;
export type RevokeOrganizationDirectRecordShareCommand = z.infer<
  typeof revokeOrganizationDirectRecordShareCommandSchema
>;
export type ChangeOrganizationDirectRecordShareResult = z.infer<
  typeof changeOrganizationDirectRecordShareResultSchema
>;
