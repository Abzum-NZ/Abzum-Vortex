import { z } from "zod";
import {
  actorIdSchema,
  applicationRootIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  permissionIdSchema,
  revisionSchema,
  ruleIdSchema,
  semanticVersionSchema,
  stableDefinitionReleaseVersionSchema,
  timestampSchema,
} from "./identifiers";
import { permissionFieldPolicySchema } from "./permissions";
import { protectedOperationReferenceSchema } from "./application-flow-bindings";

const lowercaseId = <T extends string>(value: T): T => value.toLowerCase() as T;

const flowRunAsPermissionFieldPolicySchema = permissionFieldPolicySchema.transform((value) => ({
  readableFieldIds: value.readableFieldIds.map(lowercaseId),
  changeableFieldIds: value.changeableFieldIds.map(lowercaseId),
}));

const flowRunAsProtectedOperationReferenceSchema = protectedOperationReferenceSchema.transform(
  (value) => ({
    owner:
      value.owner.kind === "application"
        ? { kind: value.owner.kind, applicationRootId: lowercaseId(value.owner.applicationRootId) }
        : value.owner.kind === "module"
          ? { kind: value.owner.kind, moduleRootId: lowercaseId(value.owner.moduleRootId) }
          : { kind: value.owner.kind, serviceId: lowercaseId(value.owner.serviceId) },
    operationId: lowercaseId(value.operationId),
  }),
);

const flowRunAsPermissionSourceSchema = z
  .object({
    kind: z.enum(["application", "module"]),
    definitionKey: namespacedKeySchema,
    rootId: z.union([
      applicationRootIdSchema.transform(lowercaseId),
      moduleRootIdSchema.transform(lowercaseId),
    ]),
    releaseVersion: stableDefinitionReleaseVersionSchema,
    releaseRevision: revisionSchema,
    validationContractVersion: semanticVersionSchema,
    contentFingerprint: fingerprintSchema,
    resolutionFingerprint: fingerprintSchema,
  })
  .strict();

const flowRunAsPermissionRegistrationWitnessSchema = z
  .object({
    registrationKind: z.literal("application"),
    registrationOwnerId: applicationRootIdSchema.transform(lowercaseId),
    registrationRevision: revisionSchema,
    source: flowRunAsPermissionSourceSchema,
  })
  .strict();

const flowRunAsRecordPermissionIntentEntryBaseSchema = z
  .object({
    nodeId: builderKeySchema,
    operation: flowRunAsProtectedOperationReferenceSchema,
    permission: z
      .object({
        applicationRootId: applicationRootIdSchema.transform(lowercaseId),
        ownerKind: z.enum(["application", "module"]),
        ownerId: z.union([
          applicationRootIdSchema.transform(lowercaseId),
          moduleRootIdSchema.transform(lowercaseId),
        ]),
        permissionId: permissionIdSchema.transform(lowercaseId),
      })
      .strict(),
    requestedFieldPolicy: flowRunAsPermissionFieldPolicySchema,
    expectedPublished: z
      .object({
        applicationReleaseRevision: revisionSchema,
        releaseVersion: stableDefinitionReleaseVersionSchema,
        contentFingerprint: fingerprintSchema,
        resolutionFingerprint: fingerprintSchema,
      })
      .strict(),
    expectedRegistration: flowRunAsPermissionRegistrationWitnessSchema,
  })
  .strict();

const flowRunAsRecordPermissionIntentEntrySchema =
  flowRunAsRecordPermissionIntentEntryBaseSchema
  .superRefine((value, context) => {
    if (value.operation.owner.kind === "platform_service")
      context.addIssue({
        code: "custom",
        path: ["operation", "owner", "kind"],
        message: "A flow Record permission must reference an Application or Module operation",
      });
    if (value.expectedRegistration.registrationOwnerId !== value.permission.applicationRootId)
      context.addIssue({
        code: "custom",
        path: ["expectedRegistration", "registrationOwnerId"],
        message: "The permission registration must belong to the selected Application",
      });
    if (
      value.expectedRegistration.source.kind !== value.permission.ownerKind ||
      value.expectedRegistration.source.rootId !== value.permission.ownerId
    )
      context.addIssue({
        code: "custom",
        path: ["expectedRegistration", "source"],
        message: "The permission source must match its exact owner",
      });
  });

const flowRunAsRecordPermissionKey = (
  value: z.infer<typeof flowRunAsRecordPermissionIntentEntryBaseSchema>,
): string =>
  [
    value.nodeId,
    value.permission.ownerKind,
    value.permission.ownerId.toLowerCase(),
    value.operation.operationId.toLowerCase(),
    value.permission.permissionId.toLowerCase(),
  ].join("\u001f");

/** A registration intent is a bounded canonical set of exact published node permissions. */
export const flowRunAsRecordPermissionIntentSchema = z
  .array(flowRunAsRecordPermissionIntentEntrySchema)
  .max(128)
  .superRefine((entries, context) => {
    const keys = entries.map(flowRunAsRecordPermissionKey);
    if (new Set(keys).size !== keys.length)
      context.addIssue({ code: "custom", message: "Record permission entries must be unique" });
    if (keys.some((key, index) => index > 0 && keys[index - 1]! >= key))
      context.addIssue({
        code: "custom",
        message: "Record permission entries must use canonical order",
      });
  });

const flowRunAsInstalledModuleBindingSchema = z
  .object({
    organizationId: organizationIdSchema.transform(lowercaseId),
    applicationRootId: applicationRootIdSchema.transform(lowercaseId),
    moduleRootId: moduleRootIdSchema.transform(lowercaseId),
    bindingRevision: revisionSchema,
    applicationReleaseRevision: revisionSchema,
    moduleReleaseRevision: revisionSchema,
    state: z.literal("active"),
  })
  .strict();

const flowRunAsInstalledModuleBindingsSchema = z
  .array(flowRunAsInstalledModuleBindingSchema)
  .min(1)
  .superRefine((bindings, context) => {
    if (
      bindings.some(
        (binding, index) => index > 0 && bindings[index - 1]!.moduleRootId >= binding.moduleRootId,
      )
    )
      context.addIssue({
        code: "custom",
        message: "Installed Module bindings must be unique and canonically ordered",
      });
  });

const flowRunAsRecordPermissionManifestEntrySchema =
  flowRunAsRecordPermissionIntentEntryBaseSchema.extend({
    effectiveFieldPolicy: flowRunAsPermissionFieldPolicySchema,
    meaningFingerprint: fingerprintSchema,
    installedModuleBindings: flowRunAsInstalledModuleBindingsSchema,
  }).superRefine((value, context) => {
    if (value.operation.owner.kind === "platform_service")
      context.addIssue({
        code: "custom",
        path: ["operation", "owner", "kind"],
        message: "A flow Record permission must reference an Application or Module operation",
      });
    if (value.expectedRegistration.registrationOwnerId !== value.permission.applicationRootId)
      context.addIssue({
        code: "custom",
        path: ["expectedRegistration", "registrationOwnerId"],
        message: "The permission registration must belong to the selected Application",
      });
    if (
      value.expectedRegistration.source.kind !== value.permission.ownerKind ||
      value.expectedRegistration.source.rootId !== value.permission.ownerId
    )
      context.addIssue({
        code: "custom",
        path: ["expectedRegistration", "source"],
        message: "The permission source must match its exact owner",
      });
  });

/** A source-validated permission manifest captured by one exact principal revision. */
export const flowRunAsRecordPermissionManifestSchema = z
  .array(flowRunAsRecordPermissionManifestEntrySchema)
  .max(128)
  .superRefine((entries, context) => {
    const keys = entries.map(flowRunAsRecordPermissionKey);
    if (new Set(keys).size !== keys.length)
      context.addIssue({ code: "custom", message: "Record permission entries must be unique" });
    if (keys.some((key, index) => index > 0 && keys[index - 1]! >= key))
      context.addIssue({
        code: "custom",
        message: "Record permission entries must use canonical order",
      });
    if (entries.length > 0) {
      const installedBindings = JSON.stringify(entries[0]!.installedModuleBindings);
      entries.forEach((entry, index) => {
        if (
          entry.permission.applicationRootId !== entry.expectedRegistration.registrationOwnerId ||
          entry.installedModuleBindings.some(
            (binding) =>
              binding.applicationRootId !== entry.permission.applicationRootId ||
              binding.applicationReleaseRevision !==
                entry.expectedPublished.applicationReleaseRevision,
          ) ||
          JSON.stringify(entry.installedModuleBindings) !== installedBindings
        )
          context.addIssue({
            code: "custom",
            path: [index, "installedModuleBindings"],
            message: "Manifest entries must share the exact Application installation snapshot",
          });
      });
    }
  });

/** The Access-owned identity selected by one compiled flow run-as binding. */
export const flowRunAsPrincipalActorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("specified_account"),
      organizationAccountId: organizationAccountIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("system"), systemActorId: actorIdSchema }).strict(),
]);

/** Expiry is evaluated at read time; revocation is an explicit stored state. */
export const flowRunAsPrincipalStateSchema = z.enum(["active", "revoked"]);
export const flowRunAsPrincipalEffectiveStateSchema = z.enum(["active", "revoked", "expired"]);

/**
 * An Access-owned, revisioned mapping from one exact compiled flow run-as binding to one
 * organisation account or registered System actor. A System revision may retain a source-bound
 * Record permission manifest; each protected use must still validate the exact current revision.
 */
export const flowRunAsPrincipalSchema = z
  .object({
    executionBindingId: containedComponentIdSchema,
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
    flowId: ruleIdSchema,
    actor: flowRunAsPrincipalActorSchema,
    expiresAt: timestampSchema.optional(),
    state: flowRunAsPrincipalStateSchema,
    revision: revisionSchema,
    recordPermissions: flowRunAsRecordPermissionManifestSchema,
    recordedAt: timestampSchema,
    revokedAt: timestampSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.state === "revoked") !== (value.revokedAt !== undefined))
      context.addIssue({
        code: "custom",
        path: ["revokedAt"],
        message: "Exactly a revoked run-as principal records its revocation time",
      });
    if (value.actor.kind === "specified_account" && value.recordPermissions.length > 0)
      context.addIssue({
        code: "custom",
        path: ["recordPermissions"],
        message: "Only a System flow principal may carry Record permission entries",
      });
    value.recordPermissions.forEach((entry, index) => {
      if (
        entry.permission.applicationRootId !== value.applicationRootId ||
        entry.expectedPublished.releaseVersion !== value.releaseVersion ||
        entry.installedModuleBindings.some(
          (binding) =>
            binding.organizationId !== value.organizationId ||
            binding.applicationRootId !== value.applicationRootId,
        )
      )
        context.addIssue({
          code: "custom",
          path: ["recordPermissions", index],
          message: "Record permission manifests must belong to the exact principal scope",
        });
    });
  });

export type FlowRunAsPrincipalActor = z.infer<typeof flowRunAsPrincipalActorSchema>;
export type FlowRunAsPrincipalState = z.infer<typeof flowRunAsPrincipalStateSchema>;
export type FlowRunAsPrincipalEffectiveState = z.infer<
  typeof flowRunAsPrincipalEffectiveStateSchema
>;
export type FlowRunAsRecordPermissionIntent = z.infer<
  typeof flowRunAsRecordPermissionIntentEntrySchema
>;
export type FlowRunAsRecordPermissionManifestEntry = z.infer<
  typeof flowRunAsRecordPermissionManifestEntrySchema
>;
export type FlowRunAsPrincipal = z.infer<typeof flowRunAsPrincipalSchema>;
