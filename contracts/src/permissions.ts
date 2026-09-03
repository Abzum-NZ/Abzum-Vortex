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

/** A contained application role may name exact permissions or all of its own non-admin permissions. */
export const applicationRolePermissionEntrySchema = z.union([namespacedKeySchema, z.literal("*")]);
export const applicationRolePermissionKeysSchema = z
  .array(applicationRolePermissionEntrySchema)
  .min(1)
  .superRefine((entries, context) => {
    if (new Set(entries).size !== entries.length)
      context.addIssue({
        code: "custom",
        message: "Application role permission entries must be unique",
      });
    if (entries.includes("*") && entries.length !== 1)
      context.addIssue({
        code: "custom",
        message: "The application permission wildcard must be the role's only permission entry",
      });
  });

export type PermissionActionKind = z.infer<typeof permissionActionKindSchema>;
export type PermissionDeclaration = z.infer<typeof permissionDeclarationSchema>;
export type ApplicationRolePermissionEntry = z.infer<typeof applicationRolePermissionEntrySchema>;
