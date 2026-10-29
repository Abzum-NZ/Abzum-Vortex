import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  identitySessionSchema,
  organizationSelectionCandidateSchema,
  type IdentitySession,
  type OrganizationSelectionCandidate,
} from "../access/identity-access";
import {
  addOrganizationAdministrationMembershipCommandSchema,
  assignOrganizationAdministrationRoleAssignmentCommandSchema,
  changeOrganizationAdministrationRoleAuthorityCommandSchema,
  createOrganizationAdministrationGroupCommandSchema,
  deactivateOrganizationAdministrationRoleActivationCommandSchema,
  prepareOrganizationAdministrationRoleChangeCommandSchema,
  removeOrganizationAdministrationMembershipCommandSchema,
  renameOrganizationAdministrationGroupCommandSchema,
  retireOrganizationAdministrationGroupCommandSchema,
  retireOrganizationAdministrationRoleCommandSchema,
  revokeOrganizationAdministrationDelegationAuthorityCommandSchema,
  grantOrganizationAdministrationDelegationAuthorityCommandSchema,
  revokeOrganizationAdministrationRoleAssignmentCommandSchema,
  reviseOrganizationAdministrationRoleMetadataCommandSchema,
} from "../access/organization-access-administration";
import {
  closeOrganizationAccountCommandSchema,
  createOrganizationInvitationForAdministrationCommandSchema,
  reactivateOrganizationAccountCommandSchema,
  revokeOrganizationInvitationForAdministrationCommandSchema,
  suspendOrganizationAccountCommandSchema,
  updateOwnProfileCommandSchema,
} from "../access/organization-local-administration";
import { organizationStewardshipAppointmentCommandSchema } from "../access/organization-stewardship";
import { jsonValueSchema, type JsonValue } from "../catalogue/common";
import { organizationIdSchema, timestampSchema, type TenantId } from "../catalogue/identifiers";
import {
  findPlatformServiceOperation,
  type PlatformServiceOperationKey,
} from "../catalogue/platform-service-operation-catalogue";
import { logRefusal } from "../catalogue/runtime-primitives";
import {
  createTenantOrganizationCommandSchema,
  reactivateTenantOrganizationCommandSchema,
  renameTenantOrganizationCommandSchema,
  reparentTenantOrganizationCommandSchema,
  suspendTenantOrganizationCommandSchema,
  type CreateTenantOrganizationCommand,
  type CreateTenantOrganizationResult,
  type ReactivateTenantOrganizationCommand,
  type ReactivateTenantOrganizationResult,
  type RenameTenantOrganizationCommand,
  type RenameTenantOrganizationResult,
  type ReparentTenantOrganizationCommand,
  type ReparentTenantOrganizationResult,
  type SuspendTenantOrganizationCommand,
  type SuspendTenantOrganizationResult,
} from "../identity/tenant-governance";
import type { ExecutionAuthorityContext } from "../workflows/flow-contracts";
import {
  flowRefusalFeedbackSchema,
  type FlowRefusalFeedback,
} from "../workflows/flow-refusal-feedback";
import type { ProtectedOperationDescriptor } from "./application-flow-bindings";
import { stableDefinitionReleaseVersionSchema } from "./version-impact";
import type { HumanOrganizationRequestResult } from "../access/human-organization-request";
import type { createOrganizationAccessAdministrationService } from "../access/organization-access-administration-access";
import type { ApplicationStoreService } from "./installation-application-store";
import { z } from "zod";
import { assignRoleAssignment, prepareRoleAssignment } from "./role-assignment-operation";
import {
  createConnectionCommandSchema,
  editConnectionCommandSchema,
  revokeConnectionCommandSchema,
  healthConnectionCommandSchema,
  type ConnectionCommand,
  type changeConnectionInstance,
} from "../connections/connection-administration";
import type { checkConnectionHealth } from "../connections/connection-health";

/**
 * One server executor for the registered platform-service protected operations. The caller (the
 * flow runner) names an operation by its exact service,
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

const protectedOperationIdentitySchema = z
  .object({
    serviceId: z.guid(),
    operationId: z.guid(),
    releaseVersion: stableDefinitionReleaseVersionSchema,
  })
  .strict();

type ProtectedOperationIdentity = z.infer<typeof protectedOperationIdentitySchema>;

/**
 * The identity of the claimed protected effect, when the caller has one. Passing it lets an
 * operation derive a stable administration duplicate key, so a retry of the same effect stays
 * idempotent at the database even when the flow run is repeated.
 */
type ProtectedOperationEffectKey = Readonly<{
  runId: string;
  taskPath: string;
  iteration: string;
}>;

type ProtectedOperationExecutionRequestBase = Readonly<{
  operation: ProtectedOperationIdentity;
  selection: OrganizationSelectionCandidate;
  inputs: Readonly<Record<string, unknown>>;
  effectKey?: ProtectedOperationEffectKey;
}>;

type ProtectedOperationExecutionRequest =
  | (ProtectedOperationExecutionRequestBase &
      Readonly<{ session: IdentitySession; executionAuthorityContext?: never }>)
  | (ProtectedOperationExecutionRequestBase &
      Readonly<{ session?: never; executionAuthorityContext: ExecutionAuthorityContext }>);

/** A value a descriptor can declare for an input or output of a registered operation. */
type ProtectedOperationValue = JsonValue;

/** The safe results the executor itself can report. */
type ProtectedOperationFailure =
  | Readonly<{ outcome: "refused" | "validation"; diagnostic?: FlowRefusalFeedback }>
  | Readonly<{ outcome: "conflict"; diagnostic?: FlowRefusalFeedback }>
  | Readonly<{ outcome: "failed" }>;

type ProtectedOperationExecution =
  | Readonly<{
      outcome: "completed" | "committed";
      outputs: Readonly<Record<string, ProtectedOperationValue>>;
    }>
  | ProtectedOperationFailure;

type Inputs = Readonly<Record<string, ProtectedOperationValue | undefined>>;
type Outputs = Readonly<Record<string, ProtectedOperationValue | null | undefined>>;

type TenantGovernanceOperations = Readonly<{
  createOrganization: (
    session: IdentitySession,
    command: CreateTenantOrganizationCommand,
  ) => Promise<CreateTenantOrganizationResult>;
  renameOrganization: (
    session: IdentitySession,
    command: RenameTenantOrganizationCommand,
  ) => Promise<RenameTenantOrganizationResult>;
  reparentOrganization: (
    session: IdentitySession,
    command: ReparentTenantOrganizationCommand,
  ) => Promise<ReparentTenantOrganizationResult>;
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
  connectionHealth: (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: z.output<typeof healthConnectionCommandSchema>,
  ) => Promise<HumanOrganizationRequestResult<Awaited<ReturnType<typeof checkConnectionHealth>>>>;
  connectionAdministration: (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    change: ConnectionCommand,
  ) => Promise<
    HumanOrganizationRequestResult<Awaited<ReturnType<typeof changeConnectionInstance>>>
  >;
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
    | "appointOrganizationSteward"
    | "assignRoleAssignment"
    | "readRole"
    | "readGroup"
    | "readOrganizationAccount"
    | "revokeRoleAssignment"
    | "deactivateRoleActivation"
    | "revokeDelegationAuthority"
    | "grantDelegationAuthority"
    | "suspendOrganizationAccount"
    | "reactivateOrganizationAccount"
    | "closeOrganizationAccount"
    | "readOwnProfile"
    | "updateOwnProfile"
    | "createOrganizationInvitation"
    | "revokeOrganizationInvitation"
  >;
  tenantGovernance: Readonly<{
    run<Result>(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      operation: (scope: TenantGovernanceRequestScope) => Promise<Result>,
    ): Promise<HumanOrganizationRequestResult<Result>>;
  }>;
  /**
   * The application catalogue's install and upgrade journeys. Only a person's interactive request
   * supplies them; without them those operations are refused like any unavailable one.
   */
  applicationStore?: ApplicationStoreService;
}>;

type ProtectedOperationExecutorDependencies = ProtectedOperationServices;

type ProtectedOperationCaller = Readonly<{
  session: IdentitySession;
  selection: OrganizationSelectionCandidate;
  effectKey?: ProtectedOperationEffectKey;
}>;

type TenantOrganizationMutationResult =
  | RenameTenantOrganizationResult
  | ReparentTenantOrganizationResult
  | SuspendTenantOrganizationResult
  | ReactivateTenantOrganizationResult;

type ConfirmedOperationFailure = Readonly<{
  kind: "confirmed_failure";
  outcome: "refused" | "conflict" | "validation";
  diagnostic: FlowRefusalFeedback;
}>;

type OperationResult =
  HumanOrganizationRequestResult<Outputs> | "validation" | "conflict" | ConfirmedOperationFailure;

type OperationRunner = (
  services: ProtectedOperationExecutorDependencies,
  caller: ProtectedOperationCaller,
  inputs: Inputs,
) => Promise<OperationResult>;
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
const operation = <Schema extends z.ZodType>(
  definition: {
    schema: Schema;
    inputAliases?: Readonly<Record<string, string>>;
    command: (
      inputs: Inputs,
      selection: OrganizationSelectionCandidate,
      effectKey: ProtectedOperationEffectKey | undefined,
    ) => unknown;
    run: (
      services: ProtectedOperationExecutorDependencies,
      caller: ProtectedOperationCaller,
      command: z.output<Schema>,
    ) => Promise<OperationResult>;
  },
  authorityKind: Operation["authorityKind"] = "permission",
): Operation =>
  Object.freeze({
    authorityKind,
    execute: async (services, caller, inputs) => {
      const command = definition.schema.safeParse(
        definition.command(inputs, caller.selection, caller.effectKey),
      );
      if (!command.success) {
        const issue = command.error.issues.length === 1 ? command.error.issues[0] : undefined;
        const structuralIssueCodes: ReadonlySet<string> = new Set([
          "invalid_type",
          "too_small",
          "too_big",
          "invalid_format",
          "not_multiple_of",
          "invalid_value",
        ]);
        const issuePath = issue?.path;
        const operationInput =
          issue !== undefined &&
          structuralIssueCodes.has(issue.code) &&
          issuePath?.length === 1 &&
          typeof issuePath[0] === "string"
            ? definition.inputAliases?.[issuePath[0]]
            : undefined;
        return {
          kind: "confirmed_failure",
          outcome: "validation",
          diagnostic: invalidCommandFeedback(operationInput),
        };
      }
      return definition.run(services, caller, command.data);
    },
  });

/** One application catalogue journey, run by the installation service under the person's own authority. */
const applicationStoreOperation = (journey: keyof ApplicationStoreService): Operation =>
  Object.freeze({
    authorityKind: "permission",
    execute: async (services, caller, inputs) => {
      const store = services.applicationStore;
      if (store === undefined) return { kind: "unavailable" };
      return store[journey](caller.session, caller.selection, inputs);
    },
  });

/** A blank optional text input, as an empty form field submits it, is the same as an absent one. */
const optionalText = (value: ProtectedOperationValue | undefined) =>
  value === null || (typeof value === "string" && value.trim() === "") ? undefined : value;

/**
 * A text control submits a string; a declared JSON input that a person types as text is parsed here
 * so the owning operation still receives a typed value, and a malformed one is a validation result.
 */
const parsedJsonInput = (value: ProtectedOperationValue): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    // The unparsed text goes on to validation, which reports the located error to the person.
    logRefusal("protected-operation", "json input parse", "json_input_not_parsable", error);
    return value;
  }
};

const mapAvailable = <Value>(
  result: HumanOrganizationRequestResult<Value>,
  project: (value: Value) => Outputs,
): HumanOrganizationRequestResult<Outputs> =>
  result.kind === "available" ? { kind: "available", value: project(result.value) } : result;

const invalidCommandFeedback = (operationInput?: string): FlowRefusalFeedback =>
  flowRefusalFeedbackSchema.parse({
    code: "invalid_command",
    ...(operationInput === undefined ? {} : { operationInput }),
  });

const runTenantOrganizationMutation = async (
  services: ProtectedOperationExecutorDependencies,
  caller: ProtectedOperationCaller,
  execute: (scope: TenantGovernanceRequestScope) => Promise<TenantOrganizationMutationResult>,
): Promise<HumanOrganizationRequestResult<Outputs> | ConfirmedOperationFailure> => {
  const scoped = await services.tenantGovernance.run(
    caller.session,
    caller.selection,
    async (scope) => {
      const result = await execute(scope);
      if (result.outcome === "refused") {
        if (result.code === "stale_revision")
          return {
            kind: "confirmed_failure",
            outcome: "conflict",
            diagnostic: flowRefusalFeedbackSchema.parse({ code: result.code }),
          } as const;
        if (result.code === "invalid_command" || result.code === "duplicate_conflict")
          return {
            kind: "confirmed_failure",
            outcome: result.code === "invalid_command" ? "validation" : "refused",
            diagnostic: flowRefusalFeedbackSchema.parse({ code: result.code }),
          } as const;
        return { kind: "unavailable" } as const;
      }
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

const createTenantOrganizationOperationCommandSchema = z
  .object({
    duplicateKey: createTenantOrganizationCommandSchema.shape.duplicateKey,
    parentOrganizationId: organizationIdSchema,
    shortName: createTenantOrganizationCommandSchema.shape.shortName,
    displayName: createTenantOrganizationCommandSchema.shape.displayName,
    stewardDisplayName:
      createTenantOrganizationCommandSchema.shape.organizationSteward.shape.accountDisplayName,
    runtimeSettings: createTenantOrganizationCommandSchema.shape.runtimeSettings,
  })
  .strict();

type CreateTenantOrganizationOperationCommand = z.output<
  typeof createTenantOrganizationOperationCommandSchema
>;

const runTenantOrganizationCreation = async (
  services: ProtectedOperationExecutorDependencies,
  caller: ProtectedOperationCaller,
  command: CreateTenantOrganizationOperationCommand,
): Promise<HumanOrganizationRequestResult<Outputs> | "validation" | ConfirmedOperationFailure> => {
  const scoped = await services.tenantGovernance.run(
    caller.session,
    caller.selection,
    async ({ tenantId, operations }) => {
      const candidate = createTenantOrganizationCommandSchema.safeParse({
        operation: "create_tenant_organization",
        duplicateKey: command.duplicateKey,
        tenantId,
        parentOrganizationId: command.parentOrganizationId,
        shortName: command.shortName,
        displayName: command.displayName,
        organizationSteward: {
          // The creator is the only nominee; steward identity never comes from operation input.
          identityId: caller.session.identityId,
          accountDisplayName: command.stewardDisplayName,
          accountLanguage: command.runtimeSettings.language,
          accountTimeZone: command.runtimeSettings.timeZone,
        },
        runtimeSettings: command.runtimeSettings,
      });
      if (!candidate.success) return "validation" as const;

      const result = await operations.createOrganization(caller.session, candidate.data);
      if (result.outcome === "refused") {
        if (
          result.code === "invalid_command" ||
          result.code === "duplicate_conflict" ||
          result.code === "stale_revision"
        )
          return {
            kind: "confirmed_failure",
            outcome: result.code === "invalid_command" ? "validation" : "refused",
            diagnostic: flowRefusalFeedbackSchema.parse({ code: result.code }),
          } as const;
        if (result.code === "operation_unavailable")
          return { kind: "temporarily_unavailable" } as const;
        return { kind: "unavailable" } as const;
      }
      return {
        kind: "available",
        value: {
          organization_id: result.organizationId,
          revision: result.organizationRevision,
        },
      } as const;
    },
  );
  return scoped.kind === "available" ? scoped.value : scoped;
};

const roleAssignmentCommand = (inputs: Inputs) => ({
  roleId: inputs.role_id,
  expectedRoleRevision: inputs.expected_role_revision,
  assigneeKind: inputs.assignee_kind,
  organizationAccountId: optionalText(inputs.organization_account_id),
  groupId: optionalText(inputs.group_id),
  assignmentKind: inputs.assignment_kind,
  startsAt: optionalText(inputs.starts_at),
  expiresAt: optionalText(inputs.expires_at),
});

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
  create_tenant_organization: operation(
    {
      schema: createTenantOrganizationOperationCommandSchema,
      command: (inputs, _selection, effectKey) => ({
        duplicateKey: duplicateKeyFor(effectKey, randomUUID),
        parentOrganizationId: inputs.parent_organization_id,
        shortName: inputs.short_name,
        displayName: inputs.display_name,
        stewardDisplayName: inputs.steward_display_name,
        runtimeSettings: {
          language: inputs.language,
          timeZone: inputs.time_zone,
          currency: inputs.currency,
          dateFormat: inputs.date_format,
          numberFormat: inputs.number_format,
        },
      }),
      run: async (services, caller, command) =>
        runTenantOrganizationCreation(services, caller, command),
    },
    "tenant_capability",
  ),
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
    inputAliases: { startsAt: "starts_at", expiresAt: "expires_at" },
    command: (inputs) => ({
      groupId: inputs.group_id,
      organizationAccountId: inputs.organization_account_id,
      startsAt: optionalText(inputs.starts_at),
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
    inputAliases: { privilegeClassification: "privilege_classification" },
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
    run: async (services, caller, command) => {
      const result = await services.accessAdministration.prepareRoleChange(
        caller.session,
        caller.selection,
        command,
      );
      if (result.kind === "invalid_privilege_classification")
        return {
          kind: "confirmed_failure",
          outcome: "validation",
          diagnostic: invalidCommandFeedback("privilege_classification"),
        };
      return mapAvailable(result, (evidence) => ({ evidence: evidence as unknown as JsonValue }));
    },
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
  prepare_role_assignment: operation({
    schema: assignOrganizationAdministrationRoleAssignmentCommandSchema,
    inputAliases: { startsAt: "starts_at", expiresAt: "expires_at" },
    command: roleAssignmentCommand,
    run: (services, caller, command) =>
      prepareRoleAssignment(services.accessAdministration, caller, command),
  }),
  assign_role_assignment: operation({
    schema: assignOrganizationAdministrationRoleAssignmentCommandSchema,
    inputAliases: { startsAt: "starts_at", expiresAt: "expires_at" },
    command: roleAssignmentCommand,
    run: (services, caller, command) =>
      assignRoleAssignment(services.accessAdministration, caller, command),
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
  grant_delegation_authority: operation({
    schema: grantOrganizationAdministrationDelegationAuthorityCommandSchema,
    command: (inputs) => ({
      holderKind: inputs.holder_kind,
      holderId: inputs.holder_id,
      expectedHolderRevision: inputs.expected_holder_revision,
    }),
    run: async (services, caller, command) =>
      mapAvailable(
        await services.accessAdministration.grantDelegationAuthority(
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
  rename_tenant_organization: operation(
    {
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
    },
    "tenant_capability",
  ),
  reparent_tenant_organization: operation(
    {
      schema: reparentTenantOrganizationCommandSchema
        .omit({ tenantId: true, operation: true })
        .extend({ parentOrganizationId: organizationIdSchema }),
      inputAliases: { parentOrganizationId: "parent_organization_id" },
      command: (inputs, _selection, effectKey) => ({
        duplicateKey: duplicateKeyFor(effectKey, randomUUID),
        organizationId: inputs.organization_id,
        expectedRevision: inputs.expected_revision,
        parentOrganizationId: inputs.parent_organization_id,
      }),
      run: async (services, caller, command) =>
        runTenantOrganizationMutation(services, caller, ({ tenantId, operations }) =>
          operations.reparentOrganization(caller.session, {
            ...command,
            operation: "reparent_tenant_organization",
            tenantId,
          }),
        ),
    },
    "tenant_capability",
  ),
  suspend_tenant_organization: operation(
    {
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
    },
    "tenant_capability",
  ),
  reactivate_tenant_organization: operation(
    {
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
    },
    "tenant_capability",
  ),
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
      if (result.value === "conflict") return "conflict";
      if (result.value.outcome === "refused") {
        logRefusal("protected-operation", "update own profile", "profile_update_refused");
        return { kind: "unavailable" };
      }
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
      roleIds: inputs.role_ids,
    }),
    run: async (services, caller, command) => {
      const result = await services.accessAdministration.createOrganizationInvitation(
        caller.session,
        caller.selection,
        command,
      );
      if (result.kind !== "available") return result;
      const value = result.value;
      if (value.outcome === "already_pending")
        return {
          kind: "confirmed_failure",
          outcome: "refused",
          diagnostic: flowRefusalFeedbackSchema.parse({ code: "invitation_already_pending" }),
        } as const;
      if (value.outcome === "role_not_delegable")
        return {
          kind: "confirmed_failure",
          outcome: "refused",
          diagnostic: flowRefusalFeedbackSchema.parse({ code: "invitation_role_not_delegable" }),
        } as const;
      return {
        kind: "available",
        value: {
          invitation_id: value.invitationId,
          revision: value.revision,
          access_version: value.accessVersion,
        },
      };
    },
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
  appoint_organization_steward: operation({
    schema: organizationStewardshipAppointmentCommandSchema,
    inputAliases: {
      organizationAccountId: "target_account_id",
      expectedAccountRevision: "expected_account_revision",
    },
    command: (inputs) => ({
      operation: "appoint_organization_steward",
      organizationAccountId: inputs.target_account_id,
      expectedAccountRevision: inputs.expected_account_revision,
    }),
    run: async (services, caller, command) => {
      const attempt = await services.accessAdministration.appointOrganizationSteward(
        caller.session,
        caller.selection,
        command,
      );
      if (attempt.kind !== "available") return attempt;
      if (attempt.value.outcome === "conflict") return "conflict";
      return {
        kind: "available",
        value: { appointment_outcome: attempt.value.outcome },
      };
    },
  }),
  create_connection_instance: operation({
    schema: createConnectionCommandSchema,
    command: (inputs, _selection, effectKey) => ({
      commandId: duplicateKeyFor(effectKey, randomUUID),
      connectionTypeId: inputs.connection_type_id,
      connectionTypeVersion: inputs.connection_type_version,
      destinationKey: inputs.destination_key,
      secretReferenceId: inputs.secret_reference_id,
    }),
    run: async (services, caller, command) => {
      const result = await services.connectionAdministration(caller.session, caller.selection, {
        operation: "create",
        command,
      });
      if (result.kind !== "available") return result;
      if (result.value.outcome === "conflict") return "conflict";
      return {
        kind: "available",
        value: {
          connection_instance_id: result.value.connectionInstanceId,
          revision: result.value.revision,
        },
      };
    },
  }),
  edit_connection_instance: operation({
    schema: editConnectionCommandSchema,
    command: (inputs, _selection, effectKey) => ({
      commandId: duplicateKeyFor(effectKey, randomUUID),
      connectionInstanceId: inputs.connection_instance_id,
      expectedRevision: inputs.expected_revision,
      destinationKey: inputs.destination_key,
      ...(optionalText(inputs.secret_reference_id) === undefined
        ? {}
        : { secretReferenceId: optionalText(inputs.secret_reference_id) }),
    }),
    run: async (services, caller, command) => {
      const result = await services.connectionAdministration(caller.session, caller.selection, {
        operation: "edit",
        command,
      });
      if (result.kind !== "available") return result;
      if (result.value.outcome === "conflict") return "conflict";
      return {
        kind: "available",
        value: {
          connection_instance_id: result.value.connectionInstanceId,
          revision: result.value.revision,
        },
      };
    },
  }),
  revoke_connection_instance: operation({
    schema: revokeConnectionCommandSchema,
    command: (inputs, _selection, effectKey) => ({
      commandId: duplicateKeyFor(effectKey, randomUUID),
      connectionInstanceId: inputs.connection_instance_id,
      expectedRevision: inputs.expected_revision,
    }),
    run: async (services, caller, command) => {
      const result = await services.connectionAdministration(caller.session, caller.selection, {
        operation: "revoke",
        command,
      });
      if (result.kind !== "available") return result;
      if (result.value.outcome === "conflict") return "conflict";
      return {
        kind: "available",
        value: {
          connection_instance_id: result.value.connectionInstanceId,
          revision: result.value.revision,
        },
      };
    },
  }),
  health_check_connection_instance: operation({
    schema: healthConnectionCommandSchema,
    command: (inputs, _selection, effectKey) => ({
      commandId: duplicateKeyFor(effectKey, randomUUID),
      connectionInstanceId: inputs.connection_instance_id,
      expectedRevision: inputs.expected_revision,
    }),
    run: async (services, caller, command) => {
      const result = await services.connectionHealth(caller.session, caller.selection, command);
      if (result.kind !== "available") return result;
      if (result.value.outcome === "conflict") return "conflict";
      return {
        kind: "available",
        value: {
          revision: result.value.revision,
          health_outcome:
            result.value.healthOutcome === "no_adapter"
              ? "No adapter available"
              : result.value.healthOutcome,
        },
      };
    },
  }),
  review_application_installation: applicationStoreOperation("review"),
  install_application: applicationStoreOperation("install"),
  upgrade_application: applicationStoreOperation("upgrade"),
  review_application_removal: applicationStoreOperation("reviewRemoval"),
  remove_application: applicationStoreOperation("remove"),
} satisfies Record<PlatformServiceOperationKey, Operation>);

/** A value of a declared type the executor does not carry yet is refused, never coerced. */
const valueMatches = (type: string, value: unknown): value is ProtectedOperationValue => {
  if (type === "text" || type === "choice") return typeof value === "string";
  if (type === "whole_number") return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "date_time")
    return typeof value === "string" && timestampSchema.safeParse(value).success;
  if (type === "yes_no") return typeof value === "boolean";
  if (type === "json") return jsonValueSchema.safeParse(value).success;
  return false;
};

type DeclaredInputResult =
  Readonly<{ inputs: Inputs }> | Readonly<{ diagnostic: FlowRefusalFeedback }>;

/**
 * The declared inputs only: every declared required input present, no undeclared input and every
 * value of its declared type. An absent or null optional input is left out.
 */
const declaredInputs = (
  descriptor: ProtectedOperationDescriptor,
  candidate: Readonly<Record<string, unknown>>,
): DeclaredInputResult => {
  if (Object.keys(candidate).some((key) => !Object.hasOwn(descriptor.inputs, key)))
    return { diagnostic: invalidCommandFeedback() };
  const inputs: Record<string, ProtectedOperationValue> = {};
  const invalidInputs: string[] = [];
  for (const [key, declaration] of Object.entries(descriptor.inputs)) {
    const value = Object.hasOwn(candidate, key) ? candidate[key] : undefined;
    if (value === undefined || value === null) {
      if (declaration.required) invalidInputs.push(key);
      continue;
    }
    if (!valueMatches(declaration.type, value)) {
      invalidInputs.push(key);
      continue;
    }
    inputs[key] = value;
  }
  if (invalidInputs.length > 0)
    return {
      diagnostic: invalidCommandFeedback(invalidInputs.length === 1 ? invalidInputs[0] : undefined),
    };
  return { inputs };
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
    const operationName = (): string =>
      protectedOperationIdentitySchema.safeParse(request.operation).data?.operationId ??
      "unidentified";
    const refuse = (code: string, cause?: unknown): ProtectedOperationExecution => {
      logRefusal("protected-operation", operationName(), code, cause);
      return { outcome: "refused" };
    };
    try {
      const identity = protectedOperationIdentitySchema.safeParse(request.operation);
      if (request.executionAuthorityContext !== undefined) {
        // The person-session executor must never downgrade a non-person authority.
        return refuse("non_person_authority_context");
      }
      const session = identitySessionSchema.safeParse(request.session);
      const selection = organizationSelectionCandidateSchema.safeParse(request.selection);
      if (!identity.success) return refuse("operation_identity_invalid", identity.error);
      if (!session.success) return refuse("session_invalid", session.error);
      if (!selection.success) return refuse("organization_selection_invalid", selection.error);
      const registered = findPlatformServiceOperation(
        identity.data.serviceId,
        identity.data.operationId,
        identity.data.releaseVersion,
      );
      if (registered === undefined) return refuse("operation_not_registered");
      const registeredOperation = operations[registered.key as PlatformServiceOperationKey];
      if (
        registeredOperation === undefined ||
        registeredOperation.authorityKind !== registered.descriptor.requiredAuthority.kind
      )
        return refuse("operation_authority_mismatch");
      if (
        typeof request.inputs !== "object" ||
        request.inputs === null ||
        Array.isArray(request.inputs)
      )
        return { outcome: "validation" };
      const checkedInputs = declaredInputs(registered.descriptor, request.inputs);
      if ("diagnostic" in checkedInputs)
        return { outcome: "validation", diagnostic: checkedInputs.diagnostic };

      const result = await registeredOperation.execute(
        services,
        {
          session: session.data,
          selection: selection.data,
          ...(request.effectKey === undefined ? {} : { effectKey: request.effectKey }),
        },
        checkedInputs.inputs,
      );
      if (result === "validation") return { outcome: "validation" };
      if (result === "conflict") return { outcome: "conflict" };
      if (result.kind === "confirmed_failure")
        return { outcome: result.outcome, diagnostic: result.diagnostic };
      if (result.kind === "unavailable") {
        if (
          result.code === "recent_authentication_required" ||
          result.code === "role_settings_change_required"
        )
          return {
            outcome: "refused",
            diagnostic: flowRefusalFeedbackSchema.parse({ code: result.code }),
          };
        return refuse("operation_unavailable");
      }
      if (result.kind === "temporarily_unavailable") {
        logRefusal("protected-operation", operationName(), "operation_temporarily_unavailable");
        return { outcome: "failed" };
      }
      const outputs = declaredOutputs(registered.descriptor, result.value);
      if (outputs === undefined) {
        logRefusal("protected-operation", operationName(), "declared_outputs_missing");
        return { outcome: "failed" };
      }
      // A successful read supplies data to later tasks without counting as a saved effect.
      return {
        outcome: registered.descriptor.effect === "read" ? "completed" : "committed",
        outputs,
      };
    } catch (error) {
      logRefusal("protected-operation", operationName(), "execution_failed", error);
      return { outcome: "failed" };
    }
  };
  const execute = (
    request: ProtectedOperationExecutionRequest,
  ): Promise<ProtectedOperationExecution> => executeWith(dependencies, request);

  return Object.freeze({
    /**
     * Runs one registered protected operation as the initiator. It never throws: every failure is
     * one of the safe results, and only a successful result carries outputs.
     */
    execute,
  });
};

export type ProtectedOperationExecutor = ReturnType<typeof createProtectedOperationExecutor>;
