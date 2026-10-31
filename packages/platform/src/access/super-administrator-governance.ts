import { z } from "zod";
import { correlationIdSchema } from "../catalogue/common";
import {
  administrationDuplicateKeySchema,
  identityIdSchema,
  revisionSchema,
  timestampSchema,
  vortexSuperAdministratorAssignmentIdSchema,
} from "../catalogue/identifiers";

export const bootstrapVortexSuperAdministratorCommandSchema = z
  .object({
    operation: z.literal("bootstrap_vortex_super_administrator"),
    duplicateKey: administrationDuplicateKeySchema,
    identityId: identityIdSchema,
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
          "assignment_unavailable",
          "stale_revision",
          "recent_authentication_required",
          "multi_factor_required",
          "duplicate_conflict",
          "operator_not_configured",
          "operation_unavailable",
        ]),
      })
      .strict(),
  ],
);
export type BootstrapVortexSuperAdministratorCommand = z.infer<
  typeof bootstrapVortexSuperAdministratorCommandSchema
>;
export type VortexSuperAdministratorAssignmentMutationResult = z.infer<
  typeof vortexSuperAdministratorAssignmentMutationResultSchema
>;
