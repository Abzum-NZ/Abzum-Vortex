import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  addOrganizationAdministrationMembershipCommandSchema,
  applicationRootIdSchema,
  assignOrganizationAdministrationRoleAssignmentCommandSchema,
  changeOrganizationAdministrationRoleAuthorityCommandSchema,
  closeOrganizationAccountCommandSchema,
  createOrganizationAdministrationGroupCommandSchema,
  createOrganizationInvitationForAdministrationCommandSchema,
  deactivateOrganizationAdministrationRoleActivationCommandSchema,
  findPlatformServiceOperation,
  identitySessionSchema,
  jsonValueSchema,
  organizationRuntimeSettingsSchema,
  organizationSelectionCandidateSchema,
  prepareOrganizationAdministrationRoleChangeCommandSchema,
  reactivateOrganizationAccountCommandSchema,
  removeOrganizationAdministrationMembershipCommandSchema,
  renameOrganizationAdministrationGroupCommandSchema,
  retireOrganizationAdministrationGroupCommandSchema,
  retireOrganizationAdministrationRoleCommandSchema,
  revokeOrganizationAdministrationDelegationAuthorityCommandSchema,
  revokeOrganizationAdministrationRoleAssignmentCommandSchema,
  revokeOrganizationInvitationForAdministrationCommandSchema,
  reviseOrganizationAdministrationRoleMetadataCommandSchema,
  stableDefinitionReleaseVersionSchema,
  reactivateTenantOrganizationCommandSchema,
  renameTenantOrganizationCommandSchema,
  suspendOrganizationAccountCommandSchema,
  suspendTenantOrganizationCommandSchema,
  updateOwnProfileCommandSchema,
  duplicateProtectionKeySchema,
  flowTaskRegistry,
  workflowNodeIdSchema,
  workflowRunIdSchema,
  workflowIdSchema,
  organizationIdSchema,
  revisionSchema,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
  type PlatformServiceOperationKey,
  type ProtectedOperationDescriptor,
  type ReactivateTenantOrganizationCommand,
  type ReactivateTenantOrganizationResult,
  type RenameTenantOrganizationCommand,
  type RenameTenantOrganizationResult,
  type SuspendTenantOrganizationCommand,
  type SuspendTenantOrganizationResult,
  type TenantId,
} from "@vortex/contracts";
import type {
  createDurableActorRequestService,
  createOrganizationAccessAdministrationService,
  createOrganizationRuntimeSettingsAdministrationService,
  HumanOrganizationRequestResult,
} from "@vortex/access";
import { verifiedDurableActorContextSchema } from "@vortex/access";
import type { DurableActorRequestScope } from "@vortex/access";
import type { RequestDatabaseTransaction } from "@vortex/db";
import { z } from "zod";

/**
 * One server executor for the registered platform-service protected operations. The caller (the
 * flow runner, and later the Kestra callback endpoint) names an operation by its exact service,
 * operation and release identity and supplies the initiator's verified session, the organisation
 * that person selected and the flow's typed inputs. The executor resolves the registered
 * operation, checks the inputs against its typed descriptor, runs the owning Access or Identity
 * service, which opens the initiator's own request transaction and re-authorises the change under
 * that person's authority, and returns only the outputs the descriptor declares.
 *
 * Nothing about the organisation, account or authority is read from the inputs: the organisation
 * is the initiator's selection and every service derives the rest from the protected request
 * context. An unknown, unregistered or wrong-release identity is refused with the same neutral
 * result a permission refusal has, so a caller learns nothing about which operations exist.
 */

export const protectedOperationIdentitySchema = z
  .object({
    serviceId: z.guid(),
    operationId: z.guid(),
    releaseVersion: stableDefinitionReleaseVersionSchema,
  })
  .strict();

export type ProtectedOperationIdentity = z.infer<typeof protectedOperationIdentitySchema>;

/**
 * The identity of the claimed protected effect, when the caller has one. Passing it lets an
 * operation derive a stable administration duplicate key, so a retry of the same effect stays
 * idempotent at the database even when the flow run is repeated.
 */
export type ProtectedOperationEffectKey = Readonly<{
  runId: string;
  taskPath: string;
  iteration: string;
}>;

export type ProtectedOperationExecutionRequest = Readonly<{
  operation: ProtectedOperationIdentity;
  session: IdentitySession;
  selection: OrganizationSelectionCandidate;
  inputs: Readonly<Record<string, unknown>>;
  effectKey?: ProtectedOperationEffectKey;
}>;

/** A durable callback names a published operation and its verified run context, never a session. */
export type DurableProtectedOperationExecutionRequest = Readonly<{
  operation: ProtectedOperationIdentity;
  actorContext: unknown;
  inputs: Readonly<Record<string, unknown>>;
}>;

/** A value a descriptor can declare for an input or output of a registered operation. */
export type ProtectedOperationValue = JsonValue;

/** The safe results the executor itself can report. */
export type ProtectedOperationExecution =
  | Readonly<{
      outcome: "completed" | "committed";
      outputs: Readonly<Record<string, ProtectedOperationValue>>;
    }>
  | Readonly<{ outcome: "refused" | "conflict" | "validation" | "failed" }>;

type DurableProtectedOperationExecution =
  | Readonly<{
      outcome: "committed";
      outputs: Readonly<Record<string, ProtectedOperationValue>>;
    }>
  | Readonly<{ outcome: "refused" | "conflict" | "validation" | "failed" }>;

const durableActorOperationPurposeSchema = z
  .object({
    runId: workflowRunIdSchema,
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseVersion: stableDefinitionReleaseVersionSchema,
    workflowId: workflowIdSchema,
    workflowRevision: revisionSchema,
    nodeId: workflowNodeIdSchema,
    attempt: z.number().int().positive(),
    operationKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    duplicateProtectionKey: duplicateProtectionKeySchema,
  })
  .passthrough();

const durableActorOperationContextSchema = verifiedDurableActorContextSchema.extend({
  purpose: durableActorOperationPurposeSchema,
});

type Inputs = Readonly<Record<string, ProtectedOperationValue | undefined>>;
type Outputs = Readonly<Record<string, ProtectedOperationValue | null | undefined>>;

type TenantGovernanceOperations = Readonly<{
  renameOrganization: (
    session: IdentitySession,
    command: RenameTenantOrganizationCommand,
  ) => Promise<RenameTenantOrganizationResult>;
  suspendOrganization: (
    session: IdentitySession,
    command: SuspendTenantOrganizationCommand,
  ) => Promise<SuspendTenantOrganizationResult>;
  reactivateOrganization: (
    session: IdentitySession,
    command: ReactivateTenantOrganizationCommand,
  ) => Promise<ReactivateTenantOrganizationResult>;
}>;

type TenantGovernanceRequestScope = Readonly<{
  tenantId: TenantId;
  operations: TenantGovernanceOperations;
}>;

type ProtectedOperationServices = Readonly<{
  accessAdministration: Pick<
    ReturnType<typeof createOrganizationAccessAdministrationService>,
    | "createGroup"
    | "renameGroup"
    | "retireGroup"
    | "addGroupMembership"
    | "removeGroupMembership"
    | "reviseRoleMetadata"
    | "retireRole"
    | "prepareRoleChange"
    | "createCustomRole"
    | "createCustomRoleFromTemplate"
    | "acceptApplicationRoleTemplate"
    | "acceptApplicationRoleRevision"
    | "assignRoleAssignment"
    | "revokeRoleAssignment"
    | "deactivateRoleActivation"
    | "revokeDelegationAuthority"
    | "suspendOrganizationAccount"
    | "reactivateOrganizationAccount"
    | "closeOrganizationAccount"
    | "readOwnProfile"
    | "updateOwnProfile"
    | "createOrganizationInvitation"
    | "revokeOrganizationInvitation"
  >;
  runtimeSettings: Pick<
    ReturnType<typeof createOrganizationRuntimeSettingsAdministrationService>,
    "update" | "setDefaultApplication"
  >;
  tenantGovernance: Readonly<{
    run<Result>(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      operation: (scope: TenantGovernanceRequestScope) => Promise<Result>,
    ): Promise<HumanOrganizationRequestResult<Result>>;
  }>;
}>;

export type ProtectedOperationExecutorDependencies = ProtectedOperationServices & Readonly<{
  /** Services bound to the actor's one request transaction and resolved scope. */
  durableOperations?: (
    transaction: RequestDatabaseTransaction,
    scope: DurableActorRequestScope,
  ) => ProtectedOperationServices;
  /** The #663 Access boundary used to re-resolve the durable run actor and current grants. */
  durableActorRequest?: Pick<ReturnType<typeof createDurableActorRequestService>, "run">;
}>;

type ProtectedOperationCaller = Readonly<{
  session: IdentitySession;
  selection: OrganizationSelectionCandidate;
  effectKey?: ProtectedOperationEffectKey;
}>;

type TenantOrganizationMutationResult =
  | RenameTenantOrganizationResult
  | SuspendTenantOrganizationResult
  | ReactivateTenantOrganizationResult;

type OperationRunner = (
  services: ProtectedOperationExecutorDependencies,
  caller: ProtectedOperationCaller,
  inputs: Inputs,
) => Promise<HumanOrganizationRequestResult<Outputs> | "validation" | "conflict">;
type Operation = Readonly<{
  authorityKind: ProtectedOperationDescriptor["requiredAuthority"]["kind"];
  execute: OperationRunner;
}>;

/**
 * A stable administration duplicate key for one claimed effect: the same run, task path and
 * iteration always derive the same key, so a repeated execution of one effect is idempotent at the
 * database. With no claimed effect key a fresh key is generated; either way the caller never
 * supplies it from input.
 */
const duplicateKeyFor = (
  effectKey: ProtectedOperationEffectKey | undefined,
  generate: () => string,
): string => {
  if (effectKey === undefined) return generate();
  const bytes = createHash("sha256")
    .update([effectKey.runId, effectKey.taskPath, effectKey.iteration].join("|"))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * Builds one operation from the contract schema of the service command it feeds. `command` maps the
 * typed inputs onto that command's fields and the schema rejects anything it does not accept, so an
 * invalid value is a validation result and never reaches the protected wrapper.
 */
const operation =
  <Schema extends z.ZodType>(definition: {
    schema: Schema;
    command: (
      inputs: Inputs,
      selection: OrganizationSelectionCandidate,
      effectKey: ProtectedOperationEffectKey | undefined,
    ) => unknown;
    run: (
      services: ProtectedOperationExecutorDependencies,
      caller: ProtectedOperationCaller,
      command: z.output<Schema>,
    ) => Promise<HumanOrganizationRequestResult<Outputs> | "conflict">;
  }, authorityKind: Operation["authorityKind"] = "permission"): Operation =>
    Object.freeze({
      authorityKind,
      execute: async (services, caller, inputs) => {
        const command = definition.schema.safeParse(
          definition.command(inputs, caller.selection, caller.effectKey),
        );
        if (!command.success) return "validation";
        return definition.run(services, caller, command.data);
      },
    });

/** A blank optional text input, as an empty form field submits it, is the same as an absent one. */
const optionalText = (value: ProtectedOperationValue | undefined) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

/**
 * A text control submits a string; a declared JSON input that a person types as text is parsed here
 * so the owning operation still receives a typed value, and a malformed one is a validation result.
 */
const parsedJsonInput = (value: ProtectedOperationValue): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const mapAvailable = <Value>(
  result: HumanOrganizationRequestResult<Value>,
  project: (value: Value) => Outputs,
): HumanOrganizationRequestResult<Outputs> =>
  result.kind === "available" ? { kind: "available", value: project(result.value) } : result;

const runTenantOrganizationMutation = async (
  services: ProtectedOperationExecutorDependencies,
  caller: ProtectedOperationCaller,
  execute: (scope: TenantGovernanceRequestScope) => Promise<TenantOrganizationMutationResult>,
): Promise<HumanOrganizationRequestResult<Outputs> | "conflict"> => {
  const scoped = await services.tenantGovernance.run(
    caller.session,
    caller.selection,
    async (scope) => {
      const result = await execute(scope);
      if (result.outcome === "refused" && result.code === "stale_revision") return "conflict" as const;
      if (result.outcome === "refused") return { kind: "unavailable" } as const;
      return {
        kind: "available",
        value: {
          organization_id: result.organizationId,
          revision: result.revision,
        },
      } as const;
    },
  );
  return scoped.kind === "available" ? scoped.value : scoped;
};

/**
 * Each registered operation, exhaustively keyed by the catalogue (`satisfies` makes a missing or
 * an unregistered key a compile error), so a newly registered operation cannot exist without an
 * executor entry here. The mapped outputs may carry more than the descriptor declares; the
 * executor keeps only declared ones.
 */
const operations: Readonly<Record<PlatformServiceOperationKey, Operation>> = Object.freeze({
  create_group: operation({
    schema: createOrganizationAdministrationGroupCommandSchema,
    command: (inputs) => ({ key: inputs.group_key, label: inputs.label }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.accessAdministration.createGroup(caller.session, caller.selection, command),
        (value) => ({
          group_id: value.group.groupId,
          revision: value.group.revision,
          access_version: value.accessVersion,
        }),
      ),
  }),
  rename_group: operation({
    schema: renameOrganizationAdministrationGroupCommandSchema,
    command: (inputs) => ({
      groupId: inputs.group_id,
      expectedGroupRevision: inputs.expected_group_revision,
      label: inputs.label,
    }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.accessAdministration.renameGroup(caller.session, caller.selection, command),
        (value) => ({
          group_id: value.group.groupId,
          revision: value.group.revision,
          access_version: value.accessVersion,
        }),
      ),
  }),
  retire_group: operation({
    schema: retireOrganizationAdministrationGroupCommandSchema,
    command: (inputs) => ({
      groupId: inputs.group_id,
      expectedGroupRevision: inputs.expected_group_revision,
    }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.accessAdministration.retireGroup(caller.session, caller.selection, command),
        (value) => ({
          group_id: value.group.groupId,
          revision: value.group.revision,
          access_version: value.accessVersion,
        }),
      ),
  }),
  add_group_membership: operation({
    schema: addOrganizationAdministrationMembershipCommandSchema,
    command: (inputs) => ({
      groupId: inputs.group_id,
      organizationAccountId: inputs.organization_account_id,
      startsAt: inputs.starts_at,
      expiresAt: optionalText(inputs.expires_at),
    }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.accessAdministration.addGroupMembership(
          caller.session,
          caller.selection,
          command,
        ),
        (value) => ({
          membership_id: value.membership.membershipId,
          revision: value.membership.revision,
          access_version: value.accessVersion,
        }),
      ),
  }),
  remove_group_membership: operation({
    schema: removeOrganizationAdministrationMembershipCommandSchema,
    command: (inputs) => ({
      membershipId: inputs.membership_id,
      expectedMembershipRevision: inputs.expected_membership_revision,
    }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.accessAdministration.removeGroupMembership(
          caller.session,
          caller.selection,
          command,
        ),
        (value) => ({
          membership_id: value.membership.membershipId,
          revision: value.membership.revision,
          access_version: value.accessVersion,
        }),
      ),
  }),
  revise_role_metadata: operation({
    schema: reviseOrganizationAdministrationRoleMetadataCommandSchema,
    command: (inputs) => ({
      roleId: inputs.role_id,
      expectedRoleRevision: inputs.expected_role_revision,
      label: inputs.label,
      description: inputs.description,
    }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.accessAdministration.reviseRoleMetadata(
          caller.session,
          caller.selection,
          command,
        ),
        (value) => ({
          role_id: value.role.roleId,
          revision: value.role.liveRevision,
          access_version: value.accessVersion,
        }),
      ),
  }),
  retire_role: operation({
    schema: retireOrganizationAdministrationRoleCommandSchema,
    command: (inputs) => ({
      roleId: inputs.role_id,
      expectedRoleRevision: inputs.expected_role_revision,
    }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.accessAdministration.retireRole(caller.session, caller.selection, command),
        (value) => ({
          role_id: value.role.roleId,
          revision: value.role.liveRevision,
          access_version: value.accessVersion,
        }),
      ),
  }),
  prepare_role_change_evidence: operation({
    schema: prepareOrganizationAdministrationRoleChangeCommandSchema,
    command: (inputs) => ({
      operation: inputs.operation,
      roleKey: inputs.role_key,
      label: inputs.label,
      description: inputs.description,
      privilegeClassification: inputs.privilege_classification,
      ...(inputs.permission_references === undefined
        ? {}
        : { permissionReferences: parsedJsonInput(inputs.permission_references) }),
      ...(inputs.template_application_root_id === undefined
        ? {}
        : { templateApplicationRootId: inputs.template_application_root_id }),
      ...(inputs.source_role_id === undefined ? {} : { sourceRoleId: inputs.source_role_id }),
      acceptBroadenedAuthority: inputs.accept_broadened_authority,
    }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.accessAdministration.prepareRoleChange(
          caller.session,
          caller.selection,
          command,
        ),
        (evidence) => ({ evidence: evidence as unknown as JsonValue }),
      ),
  }),
  create_custom_role: operation({
    schema: changeOrganizationAdministrationRoleAuthorityCommandSchema,
    command: (inputs) => ({ evidence: inputs.evidence }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.accessAdministration.createCustomRole(
          caller.session,
          caller.selection,
          command,
        ),
        (value) => ({
          role_id: value.role.roleId,
          revision: value.role.liveRevision,
          access_version: value.accessVersion,
        }),
      ),
  }),
  create_custom_role_from_template: operation({
    schema: changeOrganizationAdministrationRoleAuthorityCommandSchema,
    command: (inputs) => ({ evidence: inputs.evidence }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.accessAdministration.createCustomRoleFromTemplate(
          caller.session,
          caller.selection,
          command,
        ),
        (value) => ({
          role_id: value.role.roleId,
          revision: value.role.liveRevision,
          access_version: value.accessVersion,
        }),
      ),
  }),
  accept_application_role_template: operation({
    schema: changeOrganizationAdministrationRoleAuthorityCommandSchema,
    command: (inputs) => ({ evidence: inputs.evidence }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.accessAdministration.acceptApplicationRoleTemplate(
          caller.session,
          caller.selection,
          command,
        ),
        (value) => ({
          role_id: value.role.roleId,
          revision: value.role.liveRevision,
          access_version: value.accessVersion,
        }),
      ),
  }),
  accept_application_role_revision: operation({
    schema: changeOrganizationAdministrationRoleAuthorityCommandSchema,
    command: (inputs) => ({ evidence: inputs.evidence }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.accessAdministration.acceptApplicationRoleRevision(
          caller.session,
          caller.selection,
          command,
        ),
        (value) => ({
          role_id: value.role.roleId,
          revision: value.role.liveRevision,
          access_version: value.accessVersion,
        }),
      ),
  }),
  assign_role_assignment: operation({
    schema: assignOrganizationAdministrationRoleAssignmentCommandSchema,
    command: (inputs) => ({
      roleId: inputs.role_id,
      expectedRoleRevision: inputs.expected_role_revision,
      assigneeKind: inputs.assignee_kind,
      organizationAccountId: optionalText(inputs.organization_account_id),
      groupId: optionalText(inputs.group_id),
      assignmentKind: inputs.assignment_kind,
      startsAt: inputs.starts_at,
      expiresAt: optionalText(inputs.expires_at),
    }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.accessAdministration.assignRoleAssignment(
          caller.session,
          caller.selection,
          command,
        ),
        (value) => ({
          role_assignment_id: value.assignment.roleAssignmentId,
          revision: value.assignment.revision,
          access_version: value.accessVersion,
        }),
      ),
  }),
  revoke_role_assignment: operation({
    schema: revokeOrganizationAdministrationRoleAssignmentCommandSchema,
    command: (inputs) => ({
      roleAssignmentId: inputs.role_assignment_id,
      expectedAssignmentRevision: inputs.expected_assignment_revision,
    }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.accessAdministration.revokeRoleAssignment(
          caller.session,
          caller.selection,
          command,
        ),
        (value) => ({
          role_assignment_id: value.assignment.roleAssignmentId,
          revision: value.assignment.revision,
          access_version: value.accessVersion,
        }),
      ),
  }),
  deactivate_role_activation: operation({
    schema: deactivateOrganizationAdministrationRoleActivationCommandSchema,
    command: (inputs) => ({
      roleActivationId: inputs.role_activation_id,
      expectedActivationRevision: inputs.expected_activation_revision,
    }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.accessAdministration.deactivateRoleActivation(
          caller.session,
          caller.selection,
          command,
        ),
        (value) => ({
          role_activation_id: value.activation.roleActivationId,
          revision: value.activation.revision,
          access_version: value.accessVersion,
        }),
      ),
  }),
  revoke_delegation_authority: operation({
    schema: revokeOrganizationAdministrationDelegationAuthorityCommandSchema,
    command: (inputs) => ({
      delegationAuthorityId: inputs.delegation_authority_id,
      expectedDelegationRevision: inputs.expected_delegation_revision,
    }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.accessAdministration.revokeDelegationAuthority(
          caller.session,
          caller.selection,
          command,
        ),
        (value) => ({
          delegation_authority_id: value.delegation.delegationAuthorityId,
          revision: value.delegation.revision,
          access_version: value.accessVersion,
        }),
      ),
  }),
  update_runtime_settings: operation({
    schema: z
      .object({
        expectedRevision: z.number(),
        settings: organizationRuntimeSettingsSchema,
      })
      .strict(),
    // The organisation is the initiator's own selection, never an input, and the expected
    // revision is the revision the submitted settings are based on.
    command: (inputs, selection) => ({
      expectedRevision: inputs.expected_revision,
      settings: {
        organizationId: selection.organizationId,
        language: inputs.language,
        timeZone: inputs.time_zone,
        currency: inputs.currency,
        dateFormat: inputs.date_format,
        numberFormat: inputs.number_format,
        revision: inputs.expected_revision,
      },
    }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.runtimeSettings.update(caller.session, caller.selection, command),
        (value) => ({ revision: value.revision }),
      ),
  }),
  set_default_application: operation({
    schema: z
      .object({
        expectedRevision: z.number(),
        defaultApplicationRootId: applicationRootIdSchema.nullable(),
      })
      .strict(),
    command: (inputs) => ({
      expectedRevision: inputs.expected_revision,
      defaultApplicationRootId: inputs.default_application_root_id ?? null,
    }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.runtimeSettings.setDefaultApplication(
          caller.session,
          caller.selection,
          command,
        ),
        (value) => ({
          default_application_root_id: value.defaultApplicationRootId,
          revision: value.revision,
        }),
      ),
  }),
  rename_tenant_organization: operation({
    schema: renameTenantOrganizationCommandSchema.omit({ tenantId: true, operation: true }),
    command: (inputs, _selection, effectKey) => ({
      duplicateKey: duplicateKeyFor(effectKey, randomUUID),
      organizationId: inputs.organization_id,
      expectedRevision: inputs.expected_revision,
      displayName: inputs.display_name,
    }),
    run: async (services, caller, command) =>
      runTenantOrganizationMutation(services, caller, ({ tenantId, operations }) =>
        operations.renameOrganization(caller.session, {
          ...command,
          operation: "rename_tenant_organization",
          tenantId,
        }),
      ),
  }, "tenant_capability"),
  suspend_tenant_organization: operation({
    schema: suspendTenantOrganizationCommandSchema.omit({ tenantId: true, operation: true }),
    command: (inputs, _selection, effectKey) => ({
      duplicateKey: duplicateKeyFor(effectKey, randomUUID),
      organizationId: inputs.organization_id,
      expectedRevision: inputs.expected_revision,
    }),
    run: async (services, caller, command) =>
      runTenantOrganizationMutation(services, caller, ({ tenantId, operations }) =>
        operations.suspendOrganization(caller.session, {
          ...command,
          operation: "suspend_tenant_organization",
          tenantId,
        }),
      ),
  }, "tenant_capability"),
  reactivate_tenant_organization: operation({
    schema: reactivateTenantOrganizationCommandSchema.omit({ tenantId: true, operation: true }),
    command: (inputs, _selection, effectKey) => ({
      duplicateKey: duplicateKeyFor(effectKey, randomUUID),
      organizationId: inputs.organization_id,
      expectedRevision: inputs.expected_revision,
    }),
    run: async (services, caller, command) =>
      runTenantOrganizationMutation(services, caller, ({ tenantId, operations }) =>
        operations.reactivateOrganization(caller.session, {
          ...command,
          operation: "reactivate_tenant_organization",
          tenantId,
        }),
      ),
  }, "tenant_capability"),
  suspend_organization_account: operation({
    schema: suspendOrganizationAccountCommandSchema,
    command: (inputs, _selection, effectKey) => ({
      duplicateKey: duplicateKeyFor(effectKey, randomUUID),
      organizationAccountId: inputs.organization_account_id,
      expectedRevision: inputs.expected_revision,
    }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.accessAdministration.suspendOrganizationAccount(
          caller.session,
          caller.selection,
          command,
        ),
        (value) => ({
          organization_account_id: value.organizationAccountId,
          revision: value.revision,
          access_version: value.accessVersion,
        }),
      ),
  }),
  reactivate_organization_account: operation({
    schema: reactivateOrganizationAccountCommandSchema,
    command: (inputs, _selection, effectKey) => ({
      duplicateKey: duplicateKeyFor(effectKey, randomUUID),
      organizationAccountId: inputs.organization_account_id,
      expectedRevision: inputs.expected_revision,
    }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.accessAdministration.reactivateOrganizationAccount(
          caller.session,
          caller.selection,
          command,
        ),
        (value) => ({
          organization_account_id: value.organizationAccountId,
          revision: value.revision,
          access_version: value.accessVersion,
        }),
      ),
  }),
  close_organization_account: operation({
    schema: closeOrganizationAccountCommandSchema,
    command: (inputs, _selection, effectKey) => ({
      duplicateKey: duplicateKeyFor(effectKey, randomUUID),
      organizationAccountId: inputs.organization_account_id,
      expectedRevision: inputs.expected_revision,
    }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.accessAdministration.closeOrganizationAccount(
          caller.session,
          caller.selection,
          command,
        ),
        (value) => ({
          organization_account_id: value.organizationAccountId,
          revision: value.revision,
          access_version: value.accessVersion,
        }),
      ),
  }),
  read_own_profile: operation({
    schema: z.object({}).strict(),
    command: () => ({}),
    run: async (services, caller) =>
      mapAvailable(
        await services.accessAdministration.readOwnProfile(caller.session, caller.selection),
        (value) => ({
          organization_account_id: value.organizationAccountId,
          revision: value.revision,
          display_name: value.displayName ?? "",
          language: value.language ?? "",
          time_zone: value.timeZone ?? "",
        }),
      ),
  }),
  update_own_profile: operation({
    schema: updateOwnProfileCommandSchema,
    command: (inputs) => ({
      organizationAccountId: inputs.organization_account_id,
      expectedRevision: inputs.expected_revision,
      displayName: inputs.display_name,
      ...(optionalText(inputs.language) === undefined
        ? {}
        : { language: optionalText(inputs.language) }),
      ...(optionalText(inputs.time_zone) === undefined
        ? {}
        : { timeZone: optionalText(inputs.time_zone) }),
    }),
    run: async (services, caller, command) => {
      const result = await services.accessAdministration.updateOwnProfile(
        caller.session,
        caller.selection,
        command,
      );
      if (result.kind !== "available") return result;
      if (result.value.outcome === "refused") return { kind: "unavailable" };
      return {
        kind: "available",
        value: {
          organization_account_id: result.value.account.organizationAccountId,
          revision: result.value.account.revision,
          access_version: result.value.accessVersion,
        },
      };
    },
  }),
  create_organization_invitation: operation({
    schema: createOrganizationInvitationForAdministrationCommandSchema,
    command: (inputs, _selection, effectKey) => ({
      duplicateKey: duplicateKeyFor(effectKey, randomUUID),
      invitedEmail: inputs.invited_email,
      expiresAt: inputs.expires_at,
    }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.accessAdministration.createOrganizationInvitation(
          caller.session,
          caller.selection,
          command,
        ),
        (value) => ({
          invitation_id: value.invitationId,
          revision: value.revision,
          access_version: value.accessVersion,
          ...(value.outcome === "accepted" ? { invitation_secret: value.invitationSecret } : {}),
        }),
      ),
  }),
  revoke_organization_invitation: operation({
    schema: revokeOrganizationInvitationForAdministrationCommandSchema,
    command: (inputs, _selection, effectKey) => ({
      duplicateKey: duplicateKeyFor(effectKey, randomUUID),
      invitationId: inputs.invitation_id,
      expectedRevision: inputs.expected_revision,
    }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.accessAdministration.revokeOrganizationInvitation(
          caller.session,
          caller.selection,
          command,
        ),
        (value) => ({
          invitation_id: value.invitationId,
          revision: value.revision,
          access_version: value.accessVersion,
        }),
      ),
  }),
} satisfies Record<PlatformServiceOperationKey, Operation>);

/** A value of a declared type the executor does not carry yet is refused, never coerced. */
const valueMatches = (type: string, value: unknown): value is ProtectedOperationValue => {
  if (type === "text" || type === "choice") return typeof value === "string";
  if (type === "whole_number") return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "json") return jsonValueSchema.safeParse(value).success;
  return false;
};

/**
 * The declared inputs only: every declared required input present, no undeclared input and every
 * value of its declared type. An absent or null optional input is left out.
 */
const declaredInputs = (
  descriptor: ProtectedOperationDescriptor,
  candidate: Readonly<Record<string, unknown>>,
): Inputs | undefined => {
  if (Object.keys(candidate).some((key) => !Object.hasOwn(descriptor.inputs, key))) return undefined;
  const inputs: Record<string, ProtectedOperationValue> = {};
  for (const [key, declaration] of Object.entries(descriptor.inputs)) {
    const value = Object.hasOwn(candidate, key) ? candidate[key] : undefined;
    if (value === undefined || value === null) {
      if (declaration.required) return undefined;
      continue;
    }
    if (!valueMatches(declaration.type, value)) return undefined;
    inputs[key] = value;
  }
  return inputs;
};

/**
 * Only the outputs the descriptor declares, each of its declared type. A missing required output or
 * a mistyped one means the result cannot be trusted, so nothing is returned for it.
 */
const declaredOutputs = (
  descriptor: ProtectedOperationDescriptor,
  produced: Outputs,
): Readonly<Record<string, ProtectedOperationValue>> | undefined => {
  const outputs: Record<string, ProtectedOperationValue> = {};
  for (const [key, declaration] of Object.entries(descriptor.outputs)) {
    const value = produced[key];
    if (value === undefined || value === null) {
      if (declaration.required) return undefined;
      continue;
    }
    if (!valueMatches(declaration.type, value)) return undefined;
    outputs[key] = value;
  }
  return Object.freeze(outputs);
};

export const createProtectedOperationExecutor = (
  dependencies: ProtectedOperationExecutorDependencies,
) => {
  const executeWith = async (
    services: ProtectedOperationServices,
    request: ProtectedOperationExecutionRequest,
  ): Promise<ProtectedOperationExecution> => {
    try {
      const identity = protectedOperationIdentitySchema.safeParse(request.operation);
      const session = identitySessionSchema.safeParse(request.session);
      const selection = organizationSelectionCandidateSchema.safeParse(request.selection);
      if (!identity.success || !session.success || !selection.success)
        return { outcome: "refused" };
      const registered = findPlatformServiceOperation(
        identity.data.serviceId,
        identity.data.operationId,
        identity.data.releaseVersion,
      );
      if (registered === undefined) return { outcome: "refused" };
      const registeredOperation = operations[registered.key as PlatformServiceOperationKey];
      if (
        registeredOperation === undefined ||
        registeredOperation.authorityKind !== registered.descriptor.requiredAuthority.kind
      )
        return { outcome: "refused" };
      if (
        typeof request.inputs !== "object" ||
        request.inputs === null ||
        Array.isArray(request.inputs)
      )
        return { outcome: "validation" };
      const inputs = declaredInputs(registered.descriptor, request.inputs);
      if (inputs === undefined) return { outcome: "validation" };

      const result = await registeredOperation.execute(
        services,
        {
          session: session.data,
          selection: selection.data,
          ...(request.effectKey === undefined ? {} : { effectKey: request.effectKey }),
        },
        inputs,
      );
      if (result === "validation") return { outcome: "validation" };
      if (result === "conflict") return { outcome: "conflict" };
      if (result.kind === "unavailable") return { outcome: "refused" };
      if (result.kind === "temporarily_unavailable") return { outcome: "failed" };
      const outputs = declaredOutputs(registered.descriptor, result.value);
      if (outputs === undefined) return { outcome: "failed" };
      // A successful read supplies data to later tasks without counting as a saved effect.
      return {
        outcome: registered.descriptor.effect === "read" ? "completed" : "committed",
        outputs,
      };
    } catch {
      return { outcome: "failed" };
    }
  };
  const execute = (request: ProtectedOperationExecutionRequest): Promise<ProtectedOperationExecution> =>
    executeWith(dependencies, request);

  return Object.freeze({
    /**
     * Runs one registered protected operation as the initiator. It never throws: every failure is
     * one of the safe results, and only a successful result carries outputs.
     */
    execute,

    /**
     * Runs a registered platform-service operation from one verified durable actor context. The
     * context is re-resolved through #663 before the operation, and a durable callback never gets
     * to provide an IdentitySession or an organisation selection. Platform-service operations
     * remain person-owned; a system actor is refused rather than converted into a person.
     */
    async executeDurableActor<Result>(
      request: DurableProtectedOperationExecutionRequest & Readonly<{
        effect: (
          transaction: RequestDatabaseTransaction,
          executeOperation: () => Promise<DurableProtectedOperationExecution>,
        ) => Promise<Result>;
      }>,
    ): Promise<Readonly<{ kind: "available"; value: Result }> | Readonly<{ kind: "refused" | "failed" }>> {
      try {
        const durableActorRequest = dependencies.durableActorRequest;
        const durableOperations = dependencies.durableOperations;
        const context = durableActorOperationContextSchema.safeParse(request.actorContext);
        const identity = protectedOperationIdentitySchema.safeParse(request.operation);
        if (!durableActorRequest || !durableOperations || !context.success || !identity.success)
          return { kind: "refused" };
        const operationCallKey =
          flowTaskRegistry["operation.call"].protectedOperationKey ??
          "workflow.task.operation.call";
        if (context.data.purpose.operationKey !== operationCallKey)
          return { kind: "refused" };

        const registered = findPlatformServiceOperation(
          identity.data.serviceId,
          identity.data.operationId,
          identity.data.releaseVersion,
        );
        if (registered === undefined) return { kind: "refused" };
        const registeredOperation = operations[registered.key as PlatformServiceOperationKey];
        if (
          registeredOperation === undefined ||
          registeredOperation.authorityKind !== registered.descriptor.requiredAuthority.kind
        )
          return { kind: "refused" };

        const actorResolution = await durableActorRequest.run(
          context.data,
          async (transaction, scope) => {
            const policy = context.data.policy;
            if (policy.kind !== "initiating_person" ||
                scope.actor.kind !== "organization_account" ||
                scope.actor.organizationAccountId.toLowerCase() !==
                  policy.initiator.organizationAccountId.toLowerCase())
              throw Object.assign(new Error("DURABLE_OPERATION_ACTOR_MISMATCH"), { code: "42501" });
            const session = identitySessionSchema.parse({
              identityId: policy.initiator.identityId,
              sessionId: context.data.purpose.runId,
              authenticationStrength: "single_factor",
              accessTokenIssuedAt: context.data.issuedAt,
              accessTokenExpiresAt: context.data.expiresAt,
            });
            const selection = organizationSelectionCandidateSchema.parse({
              organizationId: scope.organizationId,
              applicationRootId: scope.applicationRootId,
            });
            let called = false;
            return request.effect(transaction, async (): Promise<DurableProtectedOperationExecution> => {
              if (called) throw new Error("DURABLE_OPERATION_REPEATED");
              called = true;
              const result = await executeWith(durableOperations(transaction, scope), {
                operation: identity.data,
                session,
                selection,
                inputs: request.inputs,
                effectKey: {
                  runId: context.data.purpose.runId,
                  taskPath: context.data.purpose.nodeId,
                  iteration: context.data.purpose.duplicateProtectionKey,
                },
              });
              // The durable workflow effect ledger records successful reads as completed steps.
              if ("outputs" in result) return { outcome: "committed", outputs: result.outputs };
              return result;
            });
          },
        );
        if (actorResolution.kind === "unavailable") return { kind: "refused" };
        if (actorResolution.kind === "temporarily_unavailable") return { kind: "failed" };
        return { kind: "available", value: actorResolution.value };
      } catch {
        return { kind: "failed" };
      }
    },
  });
};

export type ProtectedOperationExecutor = ReturnType<typeof createProtectedOperationExecutor>;
