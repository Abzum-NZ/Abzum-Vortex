import { z } from "zod";
import { correlationIdSchema, labelSchema } from "./common";
import {
  actorIdSchema,
  builderKeySchema,
  groupIdSchema,
  organizationIdSchema,
  revisionSchema,
} from "./identifiers";
import { groupSchema } from "./organization-access-catalogue";

const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);

const trustedChangeFields = {
  changedBy: actorIdSchema,
  correlationId: correlationIdSchema,
};

export const organizationGroupChangeCommandSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("create_group"),
      organizationId: organizationIdSchema,
      groupId: groupIdSchema,
      key: builderKeySchema,
      label: labelSchema,
      ...trustedChangeFields,
    })
    .strict(),
  z
    .object({
      operation: z.literal("revise_group_label"),
      organizationId: organizationIdSchema,
      groupId: groupIdSchema,
      expectedGroupRevision: javascriptSafeRevisionSchema,
      label: labelSchema,
      ...trustedChangeFields,
    })
    .strict(),
  z
    .object({
      operation: z.literal("retire_group"),
      organizationId: organizationIdSchema,
      groupId: groupIdSchema,
      expectedGroupRevision: javascriptSafeRevisionSchema,
      ...trustedChangeFields,
    })
    .strict(),
]);

const representsSameInstant = (left: string, right: string): boolean =>
  Date.parse(left) === Date.parse(right);

export const organizationGroupChangeResultSchema = z
  .object({
    outcome: z.literal("changed"),
    operation: z.enum(["create_group", "revise_group_label", "retire_group"]),
    group: groupSchema,
    accessVersion: javascriptSafeRevisionSchema,
    correlationId: correlationIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.group.changeCorrelationId !== value.correlationId)
      context.addIssue({
        code: "custom",
        path: ["correlationId"],
        message: "The result must be bound to the Group change",
      });

    if (
      value.operation === "create_group" &&
      (value.group.state !== "active" ||
        value.group.revision !== 1 ||
        value.group.createdByActorId !== value.group.changedByActorId ||
        !representsSameInstant(value.group.createdAt, value.group.changedAt))
    )
      context.addIssue({
        code: "custom",
        path: ["group"],
        message: "A created Group must contain exact revision-one creation evidence",
      });

    if (
      value.operation === "revise_group_label" &&
      (value.group.state !== "active" || value.group.revision <= 1)
    )
      context.addIssue({
        code: "custom",
        path: ["group"],
        message: "A Group label revision must return an active successor",
      });

    if (
      value.operation === "retire_group" &&
      (value.group.state !== "retired" || value.group.revision <= 1)
    )
      context.addIssue({
        code: "custom",
        path: ["group"],
        message: "Group retirement must return a terminal successor",
      });
  });

export type OrganizationGroupChangeCommand = z.infer<typeof organizationGroupChangeCommandSchema>;
export type OrganizationGroupChangeResult = z.infer<typeof organizationGroupChangeResultSchema>;
