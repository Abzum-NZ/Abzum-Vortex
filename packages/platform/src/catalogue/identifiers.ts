import { z } from "zod";
import { isBuilderKey } from "./identifier-predicates";
import { isStableId } from "./stable-id";

const nonNilUuidSchema = z.string().refine(isStableId, {
  message: "A platform-issued identifier must be a non-nil UUID",
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
export const lineageIdSchema = stableId<"LineageId">();
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
export const roleActivationIdSchema = stableId<"RoleActivationId">();
export const delegationAuthorityIdSchema = stableId<"DelegationAuthorityId">();
export const actionIdSchema = stableId<"ActionId">();
/** Permanent identity of a flow: every behaviour (action, rule, back-end flow) is one. */
export const flowIdSchema = stableId<"FlowId">();
export const eventIdSchema = stableId<"EventId">();
/** Permanent published event-declaration identity. Historical EventId remains unchanged. */
export const eventDeclarationIdSchema = stableId<"EventDeclarationId">();
/** Unique identity of one committed occurrence, distinct from its declaration. */
export const eventOccurrenceIdSchema = stableId<"EventOccurrenceId">();
export const queryIdSchema = stableId<"QueryId">();
export const pageIdSchema = stableId<"PageId">();
export const shellIdSchema = stableId<"ShellId">();
export const blockIdSchema = stableId<"BlockId">();
export const workflowNodeIdSchema = stableId<"WorkflowNodeId">();
export const workflowRunIdSchema = stableId<"WorkflowRunId">();
export const pipelineIdSchema = stableId<"PipelineId">();
export const fileIdSchema = stableId<"FileId">();
export const connectionTypeIdSchema = stableId<"ConnectionTypeId">();
export const connectionInstanceIdSchema = stableId<"ConnectionInstanceId">();
export const interfaceIdSchema = stableId<"InterfaceId">();
export const activityIdSchema = stableId<"ActivityId">();
export const retentionPolicyIdSchema = stableId<"RetentionPolicyId">();
/** Permanent current-fact identity for one tenant structural-administrator assignment. */
export const tenantAdministratorAssignmentIdSchema = stableId<"TenantAdministratorAssignmentId">();
export const vortexSuperAdministratorAssignmentIdSchema =
  stableId<"VortexSuperAdministratorAssignmentId">();
export const administrationDuplicateKeySchema = stableId<"AdministrationDuplicateKey">();
export const administrationCorrelationIdSchema = stableId<"AdministrationCorrelationId">();

export const builderKeySchema = z
  .string()
  .refine(isBuilderKey, "Use lowercase words separated by underscores, up to 40 characters");

export const sourceQualifiedRecordTypeSchema = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[a-z][a-z0-9_.]*:[a-z][a-z0-9_]*$/);

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
export const stableDefinitionReleaseVersionSchema = semanticVersionSchema.refine(
  (value) => !value.includes("-") && !value.includes("+"),
  "Published definition versions must be stable major.minor.patch versions",
);

export const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const fingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const timestampSchema = z.iso.datetime({ offset: true });

export type PlatformId = z.infer<typeof platformIdSchema>;
export type TenantId = z.infer<typeof tenantIdSchema>;
export type OrganizationId = z.infer<typeof organizationIdSchema>;
export type OrganizationAccountId = z.infer<typeof organizationAccountIdSchema>;
export type ApplicationRootId = z.infer<typeof applicationRootIdSchema>;
export type ModuleRootId = z.infer<typeof moduleRootIdSchema>;
export type ContainedComponentId = z.infer<typeof containedComponentIdSchema>;
export type RecordTypeId = z.infer<typeof recordTypeIdSchema>;
export type FieldId = z.infer<typeof fieldIdSchema>;
export type RecordId = z.infer<typeof recordIdSchema>;
export type IdentityAuthorityId = z.infer<typeof identityAuthorityIdSchema>;
export type PermissionId = z.infer<typeof permissionIdSchema>;
export type FlowId = z.infer<typeof flowIdSchema>;
export type QueryId = z.infer<typeof queryIdSchema>;
export type BlockId = z.infer<typeof blockIdSchema>;
export type FileId = z.infer<typeof fileIdSchema>;
export type ConnectionTypeId = z.infer<typeof connectionTypeIdSchema>;
export type NamespacedKey = z.infer<typeof namespacedKeySchema>;
export type SemanticVersion = z.infer<typeof semanticVersionSchema>;
export type Revision = z.infer<typeof revisionSchema>;
export type Fingerprint = z.infer<typeof fingerprintSchema>;
