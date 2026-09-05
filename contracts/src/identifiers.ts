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
export const clusterIdSchema = stableId<"ClusterId">();
export const identityAuthorityIdSchema = stableId<"IdentityAuthorityId">();
export const sessionIdSchema = stableId<"SessionId">();
export const invitationIdSchema = stableId<"InvitationId">();
export const groupIdSchema = stableId<"GroupId">();
export const membershipIdSchema = stableId<"MembershipId">();
export const permissionIdSchema = stableId<"PermissionId">();
export const roleIdSchema = stableId<"RoleId">();
export const roleActivationPolicyIdSchema = stableId<"RoleActivationPolicyId">();
export const roleAssignmentIdSchema = stableId<"RoleAssignmentId">();
export const delegationAuthorityIdSchema = stableId<"DelegationAuthorityId">();
export const directShareIdSchema = stableId<"DirectShareId">();
export const grantIdSchema = stableId<"GrantId">();
export const grantConsentRequestIdSchema = stableId<"GrantConsentRequestId">();
export const grantConsentDecisionIdSchema = stableId<"GrantConsentDecisionId">();
export const actionIdSchema = stableId<"ActionId">();
export const ruleIdSchema = stableId<"RuleId">();
export const eventIdSchema = stableId<"EventId">();
export const queryIdSchema = stableId<"QueryId">();
export const pageIdSchema = stableId<"PageId">();
export const shellIdSchema = stableId<"ShellId">();
export const blockIdSchema = stableId<"BlockId">();
export const workflowIdSchema = stableId<"WorkflowId">();
export const workflowNodeIdSchema = stableId<"WorkflowNodeId">();
export const workflowRunIdSchema = stableId<"WorkflowRunId">();
export const pipelineIdSchema = stableId<"PipelineId">();
export const fileIdSchema = stableId<"FileId">();
export const connectionTypeIdSchema = stableId<"ConnectionTypeId">();
export const connectionInstanceIdSchema = stableId<"ConnectionInstanceId">();
export const interfaceIdSchema = stableId<"InterfaceId">();
export const activityIdSchema = stableId<"ActivityId">();
export const retentionPolicyIdSchema = stableId<"RetentionPolicyId">();
export const removalReceiptIdSchema = stableId<"RemovalReceiptId">();
export const meteringEventIdSchema = stableId<"MeteringEventId">();

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
export type LineageId = z.infer<typeof lineageIdSchema>;
export type MigrationId = z.infer<typeof migrationIdSchema>;
export type ClusterId = z.infer<typeof clusterIdSchema>;
export type IdentityAuthorityId = z.infer<typeof identityAuthorityIdSchema>;
export type SessionId = z.infer<typeof sessionIdSchema>;
export type InvitationId = z.infer<typeof invitationIdSchema>;
export type GroupId = z.infer<typeof groupIdSchema>;
export type MembershipId = z.infer<typeof membershipIdSchema>;
export type PermissionId = z.infer<typeof permissionIdSchema>;
export type RoleId = z.infer<typeof roleIdSchema>;
export type RoleActivationPolicyId = z.infer<typeof roleActivationPolicyIdSchema>;
export type RoleAssignmentId = z.infer<typeof roleAssignmentIdSchema>;
export type DelegationAuthorityId = z.infer<typeof delegationAuthorityIdSchema>;
export type DirectShareId = z.infer<typeof directShareIdSchema>;
export type GrantId = z.infer<typeof grantIdSchema>;
export type GrantConsentRequestId = z.infer<typeof grantConsentRequestIdSchema>;
export type GrantConsentDecisionId = z.infer<typeof grantConsentDecisionIdSchema>;
export type ActionId = z.infer<typeof actionIdSchema>;
export type RuleId = z.infer<typeof ruleIdSchema>;
export type EventId = z.infer<typeof eventIdSchema>;
export type QueryId = z.infer<typeof queryIdSchema>;
export type PageId = z.infer<typeof pageIdSchema>;
export type ShellId = z.infer<typeof shellIdSchema>;
export type BlockId = z.infer<typeof blockIdSchema>;
export type WorkflowId = z.infer<typeof workflowIdSchema>;
export type WorkflowNodeId = z.infer<typeof workflowNodeIdSchema>;
export type WorkflowRunId = z.infer<typeof workflowRunIdSchema>;
export type PipelineId = z.infer<typeof pipelineIdSchema>;
export type FileId = z.infer<typeof fileIdSchema>;
export type ConnectionTypeId = z.infer<typeof connectionTypeIdSchema>;
export type ConnectionInstanceId = z.infer<typeof connectionInstanceIdSchema>;
export type InterfaceId = z.infer<typeof interfaceIdSchema>;
export type ActivityId = z.infer<typeof activityIdSchema>;
export type RetentionPolicyId = z.infer<typeof retentionPolicyIdSchema>;
export type RemovalReceiptId = z.infer<typeof removalReceiptIdSchema>;
export type MeteringEventId = z.infer<typeof meteringEventIdSchema>;
export type BuilderKey = z.infer<typeof builderKeySchema>;
export type NamespacedKey = z.infer<typeof namespacedKeySchema>;
export type SemanticVersion = z.infer<typeof semanticVersionSchema>;
export type Revision = z.infer<typeof revisionSchema>;
export type Fingerprint = z.infer<typeof fingerprintSchema>;
export type Timestamp = z.infer<typeof timestampSchema>;
