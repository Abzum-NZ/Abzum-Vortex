import { z } from "zod";
import { correlationIdSchema } from "./common";
import {
  actorIdSchema,
  applicationRootIdSchema,
  organizationIdSchema,
  revisionSchema,
} from "./identifiers";
import { preparedApplicationRoleTemplatesSchema } from "./organization-access-catalogue";

const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);

const preparedChangeFields = {
  preparedTemplates: preparedApplicationRoleTemplatesSchema,
  changedBy: actorIdSchema,
  correlationId: correlationIdSchema,
};

export const applicationAccessChangeCommandSchema = z
  .discriminatedUnion("operation", [
    z.object({ operation: z.literal("register"), ...preparedChangeFields }).strict(),
    ...(["update", "reactivate"] as const).map((operation) =>
      z
        .object({
          operation: z.literal(operation),
          expectedRevision: javascriptSafeRevisionSchema,
          ...preparedChangeFields,
        })
        .strict(),
    ),
    z
      .object({
        operation: z.literal("withdraw"),
        organizationId: organizationIdSchema,
        applicationRootId: applicationRootIdSchema,
        expectedRevision: javascriptSafeRevisionSchema,
        changedBy: actorIdSchema,
        correlationId: correlationIdSchema,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      value.operation !== "withdraw" &&
      value.preparedTemplates.preparationBasis.kind !== "registration_candidate"
    )
      context.addIssue({
        code: "custom",
        path: ["preparedTemplates", "preparationBasis"],
        message: "Application access changes require an exact registration candidate",
      });
  });

const applicationAccessChangeResultFields = {
  organizationId: organizationIdSchema,
  applicationRootId: applicationRootIdSchema,
  registrationRevision: javascriptSafeRevisionSchema,
  accessVersion: javascriptSafeRevisionSchema,
  correlationId: correlationIdSchema,
};

export const applicationAccessChangeResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("changed"),
      operation: z.enum(["register", "update", "reactivate", "withdraw"]),
      registrationState: z.enum(["active", "withdrawn"]),
      ...applicationAccessChangeResultFields,
    })
    .strict()
    .superRefine((value, context) => {
      if ((value.operation === "withdraw") !== (value.registrationState === "withdrawn"))
        context.addIssue({
          code: "custom",
          path: ["registrationState"],
          message: "Only withdrawal produces a withdrawn application registration",
        });
    }),
  z
    .object({
      outcome: z.literal("unchanged"),
      operation: z.literal("update"),
      registrationState: z.literal("active"),
      ...applicationAccessChangeResultFields,
    })
    .strict(),
]);

export type ApplicationAccessChangeCommand = z.infer<typeof applicationAccessChangeCommandSchema>;
export type ApplicationAccessChangeResult = z.infer<typeof applicationAccessChangeResultSchema>;
