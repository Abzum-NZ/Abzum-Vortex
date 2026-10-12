import { z } from "zod";
import { correlationIdSchema, jsonValueSchema } from "../catalogue/common";
import {
  applicationRootIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  fieldIdSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  groupIdSchema,
  platformIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  storageContractIdSchema,
} from "../catalogue/identifiers";
import { recordLinkValueSchema } from "./module-field-values";
import { safeErrorResponseSchema } from "../definition/operation-contracts";

const previewRecordInstallationIdSchema = z
  .uuid()
  .refine((value) => value !== "00000000-0000-0000-0000-000000000000");

const sharedScopeFields = {
  organizationId: organizationIdSchema,
  moduleRootId: moduleRootIdSchema,
  recordTypeId: recordTypeIdSchema,
  storageContractId: storageContractIdSchema,
  recordId: recordIdSchema,
};

export const organizationSharedRecordScopeSchema = z
  .object({ storageScope: z.literal("organization_shared"), ...sharedScopeFields })
  .strict();

export const applicationContainedRecordScopeSchema = z
  .object({
    storageScope: z.literal("application_contained"),
    ...sharedScopeFields,
    applicationRootId: applicationRootIdSchema,
  })
  .strict();

export const recordScopeSchema = z.discriminatedUnion("storageScope", [
  organizationSharedRecordScopeSchema,
  applicationContainedRecordScopeSchema,
]);

const saveRecordContractVersionSchema = z.literal("2.0.0");
const submittedRecordValuesSchema = z.record(fieldIdSchema, jsonValueSchema);

const saveRecordCommandFields = {
  contractVersion: saveRecordContractVersionSchema,
  commandId: platformIdSchema,
  recordTypeId: recordTypeIdSchema,
  submittedValues: submittedRecordValuesSchema,
  previewInstallationId: previewRecordInstallationIdSchema.optional(),
};

export const saveRecordCommandSchema = z.discriminatedUnion("operation", [
  z
    .object({
      ...saveRecordCommandFields,
      operation: z.literal("create"),
      selectedOwnerGroupId: groupIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...saveRecordCommandFields,
      operation: z.literal("update"),
      recordId: recordIdSchema,
      expectedConcurrencyNumber: revisionSchema,
    })
    .strict(),
]);

const transferRecordOwnershipCommandFields = {
  contractVersion: saveRecordContractVersionSchema,
  commandId: platformIdSchema,
  recordTypeId: recordTypeIdSchema,
  recordId: recordIdSchema,
  expectedConcurrencyNumber: revisionSchema,
};

/**
 * Fixed single-record owner change.  This is intentionally distinct from a
 * field update and from named actions; server context supplies scope and actor.
 */
export const transferRecordOwnershipCommandSchema = z
  .discriminatedUnion("targetKind", [
    z
      .object({
        ...transferRecordOwnershipCommandFields,
        targetKind: z.literal("organization_account"),
        targetOrganizationAccountId: organizationAccountIdSchema,
      })
      .strict(),
    z
      .object({
        ...transferRecordOwnershipCommandFields,
        targetKind: z.literal("group"),
        targetGroupId: groupIdSchema,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      value.targetKind === "organization_account" &&
      value.targetOrganizationAccountId === undefined
    )
      context.addIssue({
        code: "custom",
        message: "An account transfer requires an account target",
      });
    if (value.targetKind === "group" && value.targetGroupId === undefined)
      context.addIssue({ code: "custom", message: "A Group transfer requires a Group target" });
  });

export const transferRecordOwnershipResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      contractVersion: saveRecordContractVersionSchema,
      outcome: z.literal("transferred"),
      recordId: recordIdSchema,
      concurrencyNumber: revisionSchema,
      correlationId: correlationIdSchema,
      replayed: z.boolean(),
    })
    .strict(),
  z
    .object({
      contractVersion: saveRecordContractVersionSchema,
      outcome: z.literal("refused"),
      error: safeErrorResponseSchema,
    })
    .strict(),
]);

export const recordSaveFieldCorrectionSchema = z
  .object({
    code: z.enum(["invalid_value", "required_value", "field_refused"]),
    fieldId: fieldIdSchema,
    nestedPath: z
      .array(z.union([builderKeySchema, z.number().int().nonnegative()]))
      .min(1)
      .optional(),
  })
  .strict();

const readableRecordSaveProjectionSchema = z
  .object({
    recordId: recordIdSchema,
    concurrencyNumber: revisionSchema,
    readableValues: z.record(fieldIdSchema, jsonValueSchema),
  })
  .strict();

const refusedSaveRecordResultSchema = z
  .object({
    contractVersion: saveRecordContractVersionSchema,
    outcome: z.literal("refused"),
    error: safeErrorResponseSchema,
    current: readableRecordSaveProjectionSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.current !== undefined && value.error.code !== "conflict")
      context.addIssue({
        code: "custom",
        path: ["current"],
        message: "A current readable projection is supplied only for a conflict",
      });
  });

export const saveRecordResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      contractVersion: saveRecordContractVersionSchema,
      outcome: z.literal("saved"),
      recordId: recordIdSchema,
      concurrencyNumber: revisionSchema,
      readableValues: z.record(fieldIdSchema, jsonValueSchema),
      correlationId: correlationIdSchema,
      backgroundDelivery: z.enum(["none", "pending"]),
    })
    .strict(),
  z
    .object({
      contractVersion: saveRecordContractVersionSchema,
      outcome: z.literal("correction_required"),
      correlationId: correlationIdSchema,
      corrections: z.array(recordSaveFieldCorrectionSchema).min(1),
    })
    .strict(),
  refusedSaveRecordResultSchema,
]);

/** Every ordered mutation kind one record-change command may carry. */
export const recordChangeMutationKindSchema = z.enum([
  "create_subject",
  "set_fields",
  "change_relationship",
  "create_related",
  "copy_relationships",
  "delete_subject",
  "restore_subject",
  "transfer_ownership",
]);

const createRecordChangeFields = {
  values: submittedRecordValuesSchema,
  selectedOwnerGroupId: groupIdSchema.optional(),
};

/**
 * One ordered, typed record change.  A `set_fields` value of `null` clears a
 * field, and a link field's record-link value links or replaces the owning
 * edge; `change_relationship` links or unlinks an explicit relationship.
 * `create_related` creates one dependent record, `copy_relationships` copies
 * the subject's named edges to another record of the same type, and
 * `delete_subject` and `restore_subject` reuse the protected lifecycle
 * primitives.  Mutations apply in list order inside one transaction.  A
 * mutation is a statement of intent, never authority: the engine decides each
 * one against the invoking published definition and current access.
 */
export const recordChangeMutationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("create_subject"),
      ...createRecordChangeFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_fields"),
      values: submittedRecordValuesSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("change_relationship"),
      relationshipId: containedComponentIdSchema,
      change: z.enum(["link", "unlink"]),
      target: recordLinkValueSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("create_related"),
      recordTypeId: recordTypeIdSchema,
      ...createRecordChangeFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("copy_relationships"),
      relationshipIds: z.array(containedComponentIdSchema).min(1),
      targetRecordTypeId: recordTypeIdSchema,
      targetRecordId: recordIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("delete_subject") }).strict(),
  z.object({ kind: z.literal("restore_subject") }).strict(),
  z
    .object({
      kind: z.literal("transfer_ownership"),
      target: z.discriminatedUnion("targetKind", [
        z
          .object({
            targetKind: z.literal("organization_account"),
            targetOrganizationAccountId: organizationAccountIdSchema,
          })
          .strict(),
        z.object({ targetKind: z.literal("group"), targetGroupId: groupIdSchema }).strict(),
      ]),
    })
    .strict(),
]);

const subjectWritingMutationKinds: ReadonlySet<string> = new Set([
  "create_subject",
  "set_fields",
  "change_relationship",
  "create_related",
  "restore_subject",
  "transfer_ownership",
]);

/**
 * The one command that describes every record write.  It carries no actor,
 * organisation, Application, installed binding, invoking flow or action, row
 * scope or authority declaration: the trusted caller derives all of those from
 * the session and the transaction context.  The mutation list is applied in
 * order and the whole command commits or is refused as one unit.
 */
export const recordChangeCommandSchema = z
  .object({
    contractVersion: saveRecordContractVersionSchema,
    commandId: platformIdSchema,
    recordTypeId: recordTypeIdSchema,
    recordId: recordIdSchema.optional(),
    expectedConcurrencyNumber: revisionSchema.optional(),
    mutations: z.array(recordChangeMutationSchema).min(1),
    announcedEventKeys: z.array(namespacedKeySchema),
  })
  .strict()
  .superRefine((value, context) => {
    const kinds = value.mutations.map((mutation) => mutation.kind);
    const count = (kind: string): number => kinds.filter((candidate) => candidate === kind).length;
    if (value.recordId === undefined) {
      if (kinds[0] !== "create_subject" || count("create_subject") !== 1)
        context.addIssue({
          code: "custom",
          path: ["mutations"],
          message: "A new record starts with exactly one create_subject mutation",
        });
      if (value.expectedConcurrencyNumber !== undefined)
        context.addIssue({
          code: "custom",
          path: ["expectedConcurrencyNumber"],
          message: "A new record has no expected concurrency number",
        });
    } else {
      if (value.expectedConcurrencyNumber === undefined)
        context.addIssue({
          code: "custom",
          path: ["expectedConcurrencyNumber"],
          message: "A change to an existing record requires the expected concurrency number",
        });
      if (count("create_subject") > 0)
        context.addIssue({
          code: "custom",
          path: ["mutations"],
          message: "An existing record cannot be created",
        });
    }
    if (count("restore_subject") > 1)
      context.addIssue({
        code: "custom",
        path: ["mutations"],
        message: "A record is restored at most once per command",
      });
    if (
      count("restore_subject") > 0 &&
      (count("create_subject") > 0 || count("delete_subject") > 0)
    )
      context.addIssue({
        code: "custom",
        path: ["mutations"],
        message: "Restore cannot be combined with create or delete",
      });
    if (count("transfer_ownership") > 1)
      context.addIssue({
        code: "custom",
        path: ["mutations"],
        message: "Ownership transfers at most once per command",
      });
    if (count("delete_subject") > 1)
      context.addIssue({
        code: "custom",
        path: ["mutations"],
        message: "A record is deleted at most once per command",
      });
    if (count("delete_subject") > 0 && kinds.some((kind) => subjectWritingMutationKinds.has(kind)))
      context.addIssue({
        code: "custom",
        path: ["mutations"],
        message: "A deleting command may only copy relationships and announce events",
      });
    if (
      value.mutations.length !== 1 &&
      (count("restore_subject") === 1 || count("transfer_ownership") === 1)
    )
      context.addIssue({
        code: "custom",
        path: ["mutations"],
        message: "Restore and ownership transfer each run alone in one command",
      });
    for (const [index, mutation] of value.mutations.entries()) {
      if (mutation.kind !== "copy_relationships") continue;
      if (
        mutation.targetRecordTypeId.toLowerCase() !== value.recordTypeId.toLowerCase() ||
        mutation.targetRecordId.toLowerCase() === value.recordId?.toLowerCase()
      )
        context.addIssue({
          code: "custom",
          path: ["mutations", index],
          message: "Relationships are copied to another record of the subject's type",
        });
      if (
        new Set(mutation.relationshipIds.map((id) => id.toLowerCase())).size !==
        mutation.relationshipIds.length
      )
        context.addIssue({
          code: "custom",
          path: ["mutations", index, "relationshipIds"],
          message: "Each copied relationship is named once",
        });
    }
  });

/**
 * One correction a record-change command needs before it can commit.
 * `mutationIndex` names the mutation whose submitted value needs correcting, so
 * a value for a related record is never mistaken for a subject field.
 */
export const recordChangeFieldCorrectionSchema = z
  .object({
    ...recordSaveFieldCorrectionSchema.shape,
    mutationIndex: z.number().int().nonnegative(),
  })
  .strict();

/** The one receipt a committed record-change command returns. */
export const recordChangeReceiptSchema = z
  .object({
    receiptId: platformIdSchema,
    commandId: platformIdSchema,
    correlationId: correlationIdSchema,
    recordId: recordIdSchema,
    concurrencyNumber: revisionSchema,
    committedMutationKinds: z.array(recordChangeMutationKindSchema).min(1),
    announcedEventKeys: z.array(namespacedKeySchema),
  })
  .strict();

export const recordChangeResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      contractVersion: saveRecordContractVersionSchema,
      outcome: z.literal("changed"),
      recordId: recordIdSchema,
      concurrencyNumber: revisionSchema,
      readableValues: z.record(fieldIdSchema, jsonValueSchema),
      receipt: recordChangeReceiptSchema,
      backgroundDelivery: z.enum(["none", "pending"]),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.receipt.recordId.toLowerCase() !== value.recordId.toLowerCase() ||
        value.receipt.concurrencyNumber !== value.concurrencyNumber
      )
        context.addIssue({
          code: "custom",
          path: ["receipt"],
          message: "The receipt names the committed record and concurrency number",
        });
    }),
  z
    .object({
      contractVersion: saveRecordContractVersionSchema,
      outcome: z.literal("correction_required"),
      correlationId: correlationIdSchema,
      corrections: z.array(recordChangeFieldCorrectionSchema).min(1),
    })
    .strict(),
  refusedSaveRecordResultSchema,
]);

export type RecordChangeMutationKind = z.infer<typeof recordChangeMutationKindSchema>;
export type RecordChangeMutation = z.infer<typeof recordChangeMutationSchema>;
export type RecordChangeCommand = z.infer<typeof recordChangeCommandSchema>;
export type RecordChangeFieldCorrection = z.infer<typeof recordChangeFieldCorrectionSchema>;
export type RecordChangeReceipt = z.infer<typeof recordChangeReceiptSchema>;
export type RecordChangeResult = z.infer<typeof recordChangeResultSchema>;
export type RecordScope = z.infer<typeof recordScopeSchema>;
export type SaveRecordCommand = z.infer<typeof saveRecordCommandSchema>;

export const previewRecordReadCommandV1Schema = z
  .object({
    contractVersion: z.literal("1.0.0"),
    previewInstallationId: previewRecordInstallationIdSchema,
    recordTypeId: recordTypeIdSchema,
    recordId: recordIdSchema,
  })
  .strict();

export const previewRecordReadResultV1Schema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("allowed"),
      recordId: recordIdSchema,
      concurrencyNumber: revisionSchema,
      values: z.record(fieldIdSchema, jsonValueSchema),
    })
    .strict(),
  z.object({ outcome: z.literal("refused") }).strict(),
]);

export type PreviewRecordReadCommandV1 = z.infer<typeof previewRecordReadCommandV1Schema>;
export type PreviewRecordReadResultV1 = z.infer<typeof previewRecordReadResultV1Schema>;
export type TransferRecordOwnershipCommand = z.infer<
  typeof transferRecordOwnershipCommandSchema
>;
export type TransferRecordOwnershipResult = z.infer<typeof transferRecordOwnershipResultSchema>;
export type RecordSaveFieldCorrection = z.infer<typeof recordSaveFieldCorrectionSchema>;
export type SaveRecordResult = z.infer<typeof saveRecordResultSchema>;
