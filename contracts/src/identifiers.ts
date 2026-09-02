import { z } from "zod";

const nonNilUuidSchema = z
  .uuid()
  .refine((value) => value !== "00000000-0000-0000-0000-000000000000", {
    message: "A platform-issued identifier cannot be the nil UUID",
  });
const stableId = <Name extends string>() => nonNilUuidSchema.brand<Name>();

export const platformIdSchema = stableId<"PlatformId">();
export const tenantIdSchema = stableId<"TenantId">();
export const organizationIdSchema = stableId<"OrganizationId">();
export const identityIdSchema = stableId<"IdentityId">();
export const organizationAccountIdSchema = stableId<"OrganizationAccountId">();
export const applicationRootIdSchema = stableId<"ApplicationRootId">();
export const moduleRootIdSchema = stableId<"ModuleRootId">();
export const containedComponentIdSchema = stableId<"ContainedComponentId">();
export const recordTypeIdSchema = stableId<"RecordTypeId">();
export const fieldIdSchema = stableId<"FieldId">();
export const storageContractIdSchema = stableId<"StorageContractId">();
export const recordIdSchema = stableId<"RecordId">();
export const actorIdSchema = stableId<"ActorId">();
export const packageIdSchema = stableId<"PackageId">();
export const lineageIdSchema = stableId<"LineageId">();
export const migrationIdSchema = stableId<"MigrationId">();

export const builderKeySchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, "Use lowercase words separated by underscores");

export const namespacedKeySchema = z
  .string()
  .min(3)
  .max(120)
  .regex(
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$/,
    "Use lowercase dot-separated namespace segments",
  )
  .refine((value) => value.split(".").every((segment) => segment.length <= 40), {
    message: "Each namespace segment must be at most 40 characters",
  });

export const semanticVersionSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
    "Use a complete semantic version such as 1.2.3",
  );

export const revisionSchema = z.number().int().positive();
export const fingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const timestampSchema = z.iso.datetime({ offset: true });

export type PlatformId = z.infer<typeof platformIdSchema>;
export type TenantId = z.infer<typeof tenantIdSchema>;
export type OrganizationId = z.infer<typeof organizationIdSchema>;
export type IdentityId = z.infer<typeof identityIdSchema>;
export type OrganizationAccountId = z.infer<typeof organizationAccountIdSchema>;
export type ApplicationRootId = z.infer<typeof applicationRootIdSchema>;
export type ModuleRootId = z.infer<typeof moduleRootIdSchema>;
export type ContainedComponentId = z.infer<typeof containedComponentIdSchema>;
export type RecordTypeId = z.infer<typeof recordTypeIdSchema>;
export type FieldId = z.infer<typeof fieldIdSchema>;
export type StorageContractId = z.infer<typeof storageContractIdSchema>;
export type RecordId = z.infer<typeof recordIdSchema>;
export type ActorId = z.infer<typeof actorIdSchema>;
export type PackageId = z.infer<typeof packageIdSchema>;
export type BuilderKey = z.infer<typeof builderKeySchema>;
export type NamespacedKey = z.infer<typeof namespacedKeySchema>;
export type SemanticVersion = z.infer<typeof semanticVersionSchema>;
