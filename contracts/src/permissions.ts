import { z } from "zod";
import { descriptionSchema, jsonValueSchema, labelSchema } from "./common";
import {
  builderKeySchema,
  containedComponentIdSchema,
  fingerprintSchema,
  namespacedKeySchema,
  permissionIdSchema,
  recordTypeIdSchema,
  revisionSchema,
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

export const permissionRecordScopeRouteSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all_records") }).strict(),
  z.object({ kind: z.literal("ownership") }).strict(),
  z.object({ kind: z.literal("direct_share") }).strict(),
  z
    .object({
      kind: z.literal("relationship"),
      relationshipId: containedComponentIdSchema,
      sourcePermissionId: permissionIdSchema,
    })
    .strict(),
]);

export const savedConditionParameterBindingSchema = z.discriminatedUnion("source", [
  z
    .object({
      key: builderKeySchema,
      source: z.literal("current_organization_account_id"),
    })
    .strict(),
  z
    .object({
      key: builderKeySchema,
      source: z.literal("literal"),
      value: jsonValueSchema,
    })
    .strict(),
]);

export const permissionSavedConditionRestrictionSchema = z
  .object({
    conditionId: containedComponentIdSchema,
    publishedRevision: revisionSchema,
    contractFingerprint: fingerprintSchema,
    parameterBindings: z.array(savedConditionParameterBindingSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.parameterBindings.map((binding) => binding.key);
    if (new Set(keys).size !== keys.length)
      context.addIssue({
        code: "custom",
        path: ["parameterBindings"],
        message: "Saved-condition parameter bindings must be unique",
      });
    if (keys.some((key, index) => index > 0 && keys[index - 1]! >= key))
      context.addIssue({
        code: "custom",
        path: ["parameterBindings"],
        message: "Saved-condition parameter bindings must use canonical key order",
      });
  });

const recordScopeRouteRank = {
  all_records: 0,
  ownership: 1,
  direct_share: 2,
  relationship: 3,
} as const;
const recordScopeRouteIdentity = (route: z.infer<typeof permissionRecordScopeRouteSchema>) =>
  route.kind === "relationship"
    ? `${recordScopeRouteRank[route.kind]}:${route.relationshipId.toLowerCase()}:${route.sourcePermissionId.toLowerCase()}`
    : `${recordScopeRouteRank[route.kind]}:`;

export const permissionRecordScopeSchema = z
  .object({
    routes: z.array(permissionRecordScopeRouteSchema).min(1),
    savedCondition: permissionSavedConditionRestrictionSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const identities = value.routes.map(recordScopeRouteIdentity);
    if (new Set(identities).size !== identities.length)
      context.addIssue({
        code: "custom",
        path: ["routes"],
        message: "Record-scope routes must be unique",
      });
    if (identities.some((identity, index) => index > 0 && identities[index - 1]! >= identity))
      context.addIssue({
        code: "custom",
        path: ["routes"],
        message: "Record-scope routes must use canonical order",
      });
    if (value.routes.some((route) => route.kind === "all_records") && value.routes.length !== 1)
      context.addIssue({
        code: "custom",
        path: ["routes"],
        message: "The all-record route must be the sole base route",
      });
  });

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
    recordScope: permissionRecordScopeSchema.optional(),
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
export type PermissionRecordScopeRoute = z.infer<typeof permissionRecordScopeRouteSchema>;
export type PermissionRecordScope = z.infer<typeof permissionRecordScopeSchema>;
export type PermissionDeclaration = z.infer<typeof permissionDeclarationSchema>;
export type ApplicationRolePermissionEntry = z.infer<typeof applicationRolePermissionEntrySchema>;
