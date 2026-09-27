import { z } from "zod";
import { correlationIdSchema } from "./common";
import {
  administrationDuplicateKeySchema,
  identityIdSchema,
  revisionSchema,
  timestampSchema,
  vortexSuperAdministratorAssignmentIdSchema,
} from "./identifiers";

const pageLimitSchema = z.number().int().min(1).max(100);

export const vortexSuperAdministratorAssignmentSchema = z
  .object({
    assignmentId: vortexSuperAdministratorAssignmentIdSchema,
    identityId: identityIdSchema,
    revision: revisionSchema,
    grantedAt: timestampSchema,
    grantedByKind: z.enum(["configured_system_operator", "identity"]),
    grantedById: z.string().uuid(),
    changedAt: timestampSchema,
    changedByKind: z.enum(["configured_system_operator", "identity"]),
    changedById: z.string().uuid(),
    grantCorrelationId: correlationIdSchema,
    changeCorrelationId: correlationIdSchema,
    revokedAt: timestampSchema.optional(),
    revokedByKind: z.literal("identity").optional(),
    revokedById: identityIdSchema.optional(),
    revocationCorrelationId: correlationIdSchema.optional(),
  })
  .strict()
  .superRefine((assignment, context) => {
    const hasAnyRevocation =
      assignment.revokedAt !== undefined ||
      assignment.revokedByKind !== undefined ||
      assignment.revokedById !== undefined ||
      assignment.revocationCorrelationId !== undefined;
    const hasCompleteRevocation =
      assignment.revokedAt !== undefined &&
      assignment.revokedByKind !== undefined &&
      assignment.revokedById !== undefined &&
      assignment.revocationCorrelationId !== undefined;
    if (hasAnyRevocation && !hasCompleteRevocation)
      context.addIssue({
        code: "custom",
        path: ["revokedAt"],
        message: "Revocation evidence must be all present or all absent",
      });

    if (
      hasCompleteRevocation &&
      (Date.parse(assignment.changedAt) !== Date.parse(assignment.revokedAt!) ||
        assignment.changedByKind !== assignment.revokedByKind ||
        assignment.changedById !== assignment.revokedById ||
        assignment.changeCorrelationId !== assignment.revocationCorrelationId)
    )
      context.addIssue({
        code: "custom",
        path: ["revokedAt"],
        message: "A revoked assignment change must match its revocation evidence",
      });
  });

export const vortexSuperAdministratorAssignmentPageSchema = z
  .object({
    entries: z.array(vortexSuperAdministratorAssignmentSchema),
    next: vortexSuperAdministratorAssignmentIdSchema.optional(),
  })
  .strict();

export const vortexSuperAdministratorAssignmentQuerySchema = z
  .object({
    limit: pageLimitSchema,
    after: vortexSuperAdministratorAssignmentIdSchema.optional(),
  })
  .strict();

export const vortexSuperAdministratorAssignmentReadResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("available"),
        page: vortexSuperAdministratorAssignmentPageSchema,
      })
      .strict(),
    z
      .object({
        outcome: z.literal("refused"),
        code: z.enum(["invalid_request", "unavailable"]),
      })
      .strict(),
  ],
);

export const bootstrapVortexSuperAdministratorCommandSchema = z
  .object({
    operation: z.literal("bootstrap_vortex_super_administrator"),
    duplicateKey: administrationDuplicateKeySchema,
    identityId: identityIdSchema,
  })
  .strict();

export const grantVortexSuperAdministratorCommandSchema = z
  .object({
    operation: z.literal("grant_vortex_super_administrator"),
    duplicateKey: administrationDuplicateKeySchema,
    identityId: identityIdSchema,
  })
  .strict();

export const revokeVortexSuperAdministratorCommandSchema = z
  .object({
    operation: z.literal("revoke_vortex_super_administrator"),
    duplicateKey: administrationDuplicateKeySchema,
    assignmentId: vortexSuperAdministratorAssignmentIdSchema,
    expectedRevision: revisionSchema,
  })
  .strict();

const mutationFields = {
  assignmentId: vortexSuperAdministratorAssignmentIdSchema,
  identityId: identityIdSchema,
  revision: revisionSchema,
  correlationId: correlationIdSchema,
  acceptedAt: timestampSchema,
};

const operationNames = [
  "bootstrap_vortex_super_administrator",
  "grant_vortex_super_administrator",
  "revoke_vortex_super_administrator",
] as const;

export const vortexSuperAdministratorAssignmentMutationResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.enum(["accepted", "replayed"]),
        operation: z.enum(operationNames),
        ...mutationFields,
      })
      .strict(),
    z
      .object({
        outcome: z.literal("refused"),
        operation: z.enum(operationNames),
        code: z.enum([
          "invalid_command",
          "identity_unavailable",
          "stale_revision",
          "recent_authentication_required",
          "duplicate_conflict",
          "operator_not_configured",
          "operation_unavailable",
        ]),
      })
      .strict(),
  ],
);

export type VortexSuperAdministratorAssignment = z.infer<
  typeof vortexSuperAdministratorAssignmentSchema
>;
export type VortexSuperAdministratorAssignmentPage = z.infer<
  typeof vortexSuperAdministratorAssignmentPageSchema
>;
export type VortexSuperAdministratorAssignmentQuery = z.infer<
  typeof vortexSuperAdministratorAssignmentQuerySchema
>;
export type VortexSuperAdministratorAssignmentReadResult = z.infer<
  typeof vortexSuperAdministratorAssignmentReadResultSchema
>;
export type BootstrapVortexSuperAdministratorCommand = z.infer<
  typeof bootstrapVortexSuperAdministratorCommandSchema
>;
export type GrantVortexSuperAdministratorCommand = z.infer<
  typeof grantVortexSuperAdministratorCommandSchema
>;
export type RevokeVortexSuperAdministratorCommand = z.infer<
  typeof revokeVortexSuperAdministratorCommandSchema
>;
export type VortexSuperAdministratorAssignmentMutationResult = z.infer<
  typeof vortexSuperAdministratorAssignmentMutationResultSchema
>;
