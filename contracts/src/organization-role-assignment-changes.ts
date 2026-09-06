import { z } from "zod";
import { correlationIdSchema } from "./common";
import {
  actorIdSchema,
  organizationIdSchema,
  revisionSchema,
  roleAssignmentIdSchema,
  roleIdSchema,
  timestampSchema,
} from "./identifiers";
import {
  accessAssigneeSchema,
  roleAssignmentKindSchema,
  roleAssignmentSchema,
} from "./organization-access-catalogue";

const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);

const representsSameInstant = (left: string, right: string): boolean =>
  Date.parse(left) === Date.parse(right);

const trustedChangeFields = {
  changedBy: actorIdSchema,
  correlationId: correlationIdSchema,
};

export const organizationRoleAssignmentChangeCommandSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("grant"),
      organizationId: organizationIdSchema,
      roleAssignmentId: roleAssignmentIdSchema,
      roleId: roleIdSchema,
      expectedRoleRevision: javascriptSafeRevisionSchema,
      assignee: accessAssigneeSchema,
      assignmentKind: roleAssignmentKindSchema,
      startsAt: timestampSchema,
      expiresAt: timestampSchema.optional(),
      ...trustedChangeFields,
    })
    .strict()
    .refine(
      (value) =>
        value.expiresAt === undefined || Date.parse(value.expiresAt) > Date.parse(value.startsAt),
      {
        path: ["expiresAt"],
        message: "Assignment expiry must be later than its start",
      },
    ),
  z
    .object({
      operation: z.literal("revoke"),
      organizationId: organizationIdSchema,
      roleAssignmentId: roleAssignmentIdSchema,
      expectedAssignmentRevision: javascriptSafeRevisionSchema,
      ...trustedChangeFields,
    })
    .strict(),
]);

export const organizationRoleAssignmentChangeResultSchema = z
  .object({
    outcome: z.literal("changed"),
    operation: z.enum(["grant", "revoke"]),
    assignment: roleAssignmentSchema,
    accessVersion: javascriptSafeRevisionSchema,
    correlationId: correlationIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.assignment.changeCorrelationId !== value.correlationId)
      context.addIssue({
        code: "custom",
        path: ["correlationId"],
        message: "The result must be bound to the assignment change",
      });

    if (value.operation === "grant") {
      if (
        value.assignment.state !== "live" ||
        value.assignment.revision !== 1 ||
        value.assignment.grantCorrelationId !== value.correlationId ||
        value.assignment.grantedByActorId !== value.assignment.changedByActorId ||
        !representsSameInstant(value.assignment.grantedAt, value.assignment.changedAt)
      )
        context.addIssue({
          code: "custom",
          path: ["assignment"],
          message: "A grant result must contain its exact revision-one grant evidence",
        });
      return;
    }

    if (
      value.assignment.state !== "revoked" ||
      value.assignment.revision <= 1 ||
      value.assignment.revokedByActorId !== value.assignment.changedByActorId ||
      value.assignment.revokedAt === undefined ||
      !representsSameInstant(value.assignment.revokedAt, value.assignment.changedAt) ||
      value.assignment.revocationCorrelationId !== value.correlationId
    )
      context.addIssue({
        code: "custom",
        path: ["assignment"],
        message: "A revocation result must contain its exact terminal change evidence",
      });
  });

export type OrganizationRoleAssignmentChangeCommand = z.infer<
  typeof organizationRoleAssignmentChangeCommandSchema
>;
export type OrganizationRoleAssignmentChangeResult = z.infer<
  typeof organizationRoleAssignmentChangeResultSchema
>;
