import { z } from "zod";
import { descriptionSchema, labelSchema } from "./common";
import {
  builderKeySchema,
  namespacedKeySchema,
  permissionIdSchema,
  recordTypeIdSchema,
} from "./identifiers";

export const permissionActionKindSchema = z.enum([
  "create",
  "read",
  "update",
  "delete",
  "restore",
  "export",
  "share",
  "manage",
  "named",
]);

export const permissionDeclarationSchema = z
  .object({
    permissionId: permissionIdSchema,
    key: namespacedKeySchema,
    label: labelSchema,
    description: descriptionSchema,
    recordTypeId: recordTypeIdSchema.optional(),
    actionKind: permissionActionKindSchema,
    namedAction: builderKeySchema.optional(),
    administrative: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.actionKind === "named") !== (value.namedAction !== undefined))
      context.addIssue({
        code: "custom",
        path: ["namedAction"],
        message: "Named actions are present only for the named action kind",
      });
  });

export type PermissionActionKind = z.infer<typeof permissionActionKindSchema>;
export type PermissionDeclaration = z.infer<typeof permissionDeclarationSchema>;
