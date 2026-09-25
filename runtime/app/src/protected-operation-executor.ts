import "server-only";

import {
  addOrganizationAdministrationMembershipCommandSchema,
  applicationRootIdSchema,
  assignOrganizationAdministrationRoleAssignmentCommandSchema,
  createOrganizationAdministrationGroupCommandSchema,
  deactivateOrganizationAdministrationRoleActivationCommandSchema,
  findPlatformServiceOperation,
  identitySessionSchema,
  organizationRuntimeSettingsSchema,
  organizationSelectionCandidateSchema,
  removeOrganizationAdministrationMembershipCommandSchema,
  renameOrganizationAdministrationGroupCommandSchema,
  retireOrganizationAdministrationGroupCommandSchema,
  retireOrganizationAdministrationRoleCommandSchema,
  revokeOrganizationAdministrationDelegationAuthorityCommandSchema,
  revokeOrganizationAdministrationRoleAssignmentCommandSchema,
  reviseOrganizationAdministrationRoleMetadataCommandSchema,
  stableDefinitionReleaseVersionSchema,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type PlatformServiceOperationKey,
  type ProtectedOperationDescriptor,
} from "@vortex/contracts";
import type {
  createOrganizationAccessAdministrationService,
  createOrganizationRuntimeSettingsAdministrationService,
  HumanOrganizationRequestResult,
} from "@vortex/access";
import { z } from "zod";

/**
 * One server executor for the registered platform-service protected operations. The caller (the
 * flow runner, and later the Kestra callback endpoint) names an operation by its exact service,
 * operation and release identity and supplies the initiator's verified session, the organisation
 * that person selected and the flow's typed inputs. The executor resolves the registered
 * operation, checks the inputs against its typed descriptor, runs the owning Access service, which
 * opens the initiator's own request transaction and re-authorises the change under that person's
 * authority, and returns only the outputs the descriptor declares.
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

export type ProtectedOperationExecutionRequest = Readonly<{
  operation: ProtectedOperationIdentity;
  session: IdentitySession;
  selection: OrganizationSelectionCandidate;
  inputs: Readonly<Record<string, unknown>>;
}>;

/** A value a descriptor can declare for an input or output of a registered operation. */
export type ProtectedOperationValue = string | number;

/**
 * The safe results the executor itself can report. `conflict` is not reported separately: the
 * owning services fold a stale revision into their neutral refusal, so it surfaces as `refused`
 * or `failed` and never as a distinguishable signal about another person's data.
 */
export type ProtectedOperationExecution =
  | Readonly<{
      outcome: "committed";
      outputs: Readonly<Record<string, ProtectedOperationValue>>;
    }>
  | Readonly<{ outcome: "refused" | "validation" | "failed" }>;

type Inputs = Readonly<Record<string, ProtectedOperationValue | undefined>>;
type Outputs = Readonly<Record<string, ProtectedOperationValue | null | undefined>>;

export type ProtectedOperationExecutorDependencies = Readonly<{
  accessAdministration: Pick<
    ReturnType<typeof createOrganizationAccessAdministrationService>,
    | "createGroup"
    | "renameGroup"
    | "retireGroup"
    | "addGroupMembership"
    | "removeGroupMembership"
    | "reviseRoleMetadata"
    | "retireRole"
    | "assignRoleAssignment"
    | "revokeRoleAssignment"
    | "deactivateRoleActivation"
    | "revokeDelegationAuthority"
  >;
  runtimeSettings: Pick<
    ReturnType<typeof createOrganizationRuntimeSettingsAdministrationService>,
    "update" | "setDefaultApplication"
  >;
}>;

type Operation = (
  services: ProtectedOperationExecutorDependencies,
  caller: Readonly<{ session: IdentitySession; selection: OrganizationSelectionCandidate }>,
  inputs: Inputs,
) => Promise<HumanOrganizationRequestResult<Outputs> | "validation">;

/**
 * Builds one operation from the contract schema of the service command it feeds. `command` maps the
 * typed inputs onto that command's fields and the schema rejects anything it does not accept, so an
 * invalid value is a validation result and never reaches the protected wrapper.
 */
const operation =
  <Schema extends z.ZodType>(definition: {
    schema: Schema;
    command: (inputs: Inputs, selection: OrganizationSelectionCandidate) => unknown;
    run: (
      services: ProtectedOperationExecutorDependencies,
      caller: Readonly<{ session: IdentitySession; selection: OrganizationSelectionCandidate }>,
      command: z.output<Schema>,
    ) => Promise<HumanOrganizationRequestResult<Outputs>>;
  }): Operation =>
  async (services, caller, inputs) => {
    const command = definition.schema.safeParse(definition.command(inputs, caller.selection));
    if (!command.success) return "validation";
    return definition.run(services, caller, command.data);
  };

/** A blank optional text input, as an empty form field submits it, is the same as an absent one. */
const optionalText = (value: ProtectedOperationValue | undefined) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const mapAvailable = <Value>(
  result: HumanOrganizationRequestResult<Value>,
  project: (value: Value) => Outputs,
): HumanOrganizationRequestResult<Outputs> =>
  result.kind === "available" ? { kind: "available", value: project(result.value) } : result;

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
} satisfies Record<PlatformServiceOperationKey, Operation>);

/** A value of a declared type the executor does not carry yet is refused, never coerced. */
const valueMatches = (type: string, value: unknown): value is ProtectedOperationValue => {
  if (type === "text" || type === "choice") return typeof value === "string";
  if (type === "whole_number") return typeof value === "number" && Number.isSafeInteger(value);
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
) =>
  Object.freeze({
    /**
     * Runs one registered protected operation as the initiator. It never throws: every failure is
     * one of the safe results, and only a committed result carries outputs.
     */
    async execute(request: ProtectedOperationExecutionRequest): Promise<ProtectedOperationExecution> {
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
        const run = operations[registered.key as PlatformServiceOperationKey];
        if (run === undefined) return { outcome: "refused" };
        if (
          typeof request.inputs !== "object" ||
          request.inputs === null ||
          Array.isArray(request.inputs)
        )
          return { outcome: "validation" };
        const inputs = declaredInputs(registered.descriptor, request.inputs);
        if (inputs === undefined) return { outcome: "validation" };

        const result = await run(
          dependencies,
          { session: session.data, selection: selection.data },
          inputs,
        );
        if (result === "validation") return { outcome: "validation" };
        if (result.kind === "unavailable") return { outcome: "refused" };
        if (result.kind === "temporarily_unavailable") return { outcome: "failed" };
        const outputs = declaredOutputs(registered.descriptor, result.value);
        return outputs === undefined ? { outcome: "failed" } : { outcome: "committed", outputs };
      } catch {
        return { outcome: "failed" };
      }
    },
  });

export type ProtectedOperationExecutor = ReturnType<typeof createProtectedOperationExecutor>;
