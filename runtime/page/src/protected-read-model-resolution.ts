import "server-only";

import {
  protectedReadModelBindingV2Schema,
  protectedReadModelDeclarations,
  protectedReadModelPageRequestSchema,
  type IdentitySession,
  type ListOrganizationAccountsCommand,
  type ListOrganizationAccountsResult,
  type ListOrganizationInvitationsCommand,
  type ListOrganizationInvitationsResult,
  type ListOrganizationAdministrationDelegationAuthoritiesCommand,
  type ListOrganizationAdministrationDelegationAuthoritiesResult,
  type ListOrganizationAdministrationGroupsCommand,
  type ListOrganizationAdministrationGroupsResult,
  type ListOrganizationAdministrationMembershipsCommand,
  type ListOrganizationAdministrationMembershipsResult,
  type ListOrganizationAdministrationPermissionsCommand,
  type ListOrganizationAdministrationPermissionsResult,
  type ListOrganizationAdministrationRoleActivationsCommand,
  type ListOrganizationAdministrationRoleActivationsResult,
  type ListOrganizationAdministrationRoleAssignmentsCommand,
  type ListOrganizationAdministrationRoleAssignmentsResult,
  type ListOrganizationAdministrationRolesCommand,
  type ListOrganizationAdministrationRolesResult,
  type OrganizationSelectionCandidate,
  type ProtectedReadModelKey,
  type ProtectedReadModelPageRequest,
  type ReadOrganizationRuntimeSettingsCommand,
  type ReadOrganizationRuntimeSettingsResult,
  type TenantAssignmentQuery,
  type TenantAssignmentReadResult,
  type TenantHierarchyQuery,
  type TenantHierarchyResult,
  type TenantLauncherQuery,
  type TenantLauncherResult,
} from "@vortex/contracts";

type OwnerResult<Value> =
  | Readonly<{ kind: "available"; value: Value }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

/**
 * The existing protected owner readers, supplied by the composition root. Each one authorises the
 * viewer's current authority itself; this resolver adds no authority and reads no tables.
 */
export type ProtectedReadModelReaders = Readonly<{
  access: Readonly<{
    listGroupMemberships(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      command: ListOrganizationAdministrationMembershipsCommand,
    ): Promise<OwnerResult<ListOrganizationAdministrationMembershipsResult>>;
    listGroups(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      command: ListOrganizationAdministrationGroupsCommand,
    ): Promise<OwnerResult<ListOrganizationAdministrationGroupsResult>>;
    listRoles(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      command: ListOrganizationAdministrationRolesCommand,
    ): Promise<OwnerResult<ListOrganizationAdministrationRolesResult>>;
    listPermissions(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      command: ListOrganizationAdministrationPermissionsCommand,
    ): Promise<OwnerResult<ListOrganizationAdministrationPermissionsResult>>;
    listRoleAssignments(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      command: ListOrganizationAdministrationRoleAssignmentsCommand,
    ): Promise<OwnerResult<ListOrganizationAdministrationRoleAssignmentsResult>>;
    listRoleActivations(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      command: ListOrganizationAdministrationRoleActivationsCommand,
    ): Promise<OwnerResult<ListOrganizationAdministrationRoleActivationsResult>>;
    listDelegationAuthorities(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      command: ListOrganizationAdministrationDelegationAuthoritiesCommand,
    ): Promise<OwnerResult<ListOrganizationAdministrationDelegationAuthoritiesResult>>;
    listOrganizationAccounts(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      command: ListOrganizationAccountsCommand,
    ): Promise<OwnerResult<ListOrganizationAccountsResult>>;
    listOrganizationInvitations(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      command: ListOrganizationInvitationsCommand,
    ): Promise<OwnerResult<ListOrganizationInvitationsResult>>;
    readOrganizationRuntimeSettings(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      command: ReadOrganizationRuntimeSettingsCommand,
    ): Promise<OwnerResult<ReadOrganizationRuntimeSettingsResult>>;
  }>;
  identity: Readonly<{
    listTenantHierarchy(
      session: IdentitySession,
      query: TenantHierarchyQuery,
    ): Promise<TenantHierarchyResult>;
    listTenants(
      session: IdentitySession,
      query: TenantLauncherQuery,
    ): Promise<TenantLauncherResult>;
    listTenantAdministrators(
      session: IdentitySession,
      query: TenantAssignmentQuery,
    ): Promise<TenantAssignmentReadResult>;
  }>;
}>;

/** The verified request context. `tenantId` is the caller's resolved tenant, never page input. */
export type ProtectedReadModelRequestContext = Readonly<{
  session: IdentitySession;
  selection: OrganizationSelectionCandidate;
  tenantId: string;
}>;

/**
 * A neutral refusal never distinguishes an unknown model, a missing authority or a hidden fact, and
 * is never an empty page. `unavailable` is a temporary failure the page may retry.
 */
export type ProtectedReadModelResolution =
  | Readonly<{
      kind: "available";
      model: ProtectedReadModelKey;
      value: unknown;
    }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "unavailable" }>;

const refused = Object.freeze({ kind: "refused" as const });
const unavailable = Object.freeze({ kind: "unavailable" as const });

const fromOwner = <Value>(
  model: ProtectedReadModelKey,
  result: OwnerResult<Value>,
): ProtectedReadModelResolution =>
  result.kind === "available"
    ? { kind: "available", model, value: result.value }
    : result.kind === "temporarily_unavailable"
      ? unavailable
      : refused;

export const createProtectedReadModelResolver = (readers: ProtectedReadModelReaders) => ({
  async resolve(
    context: ProtectedReadModelRequestContext,
    bindingCandidate: unknown,
    requestCandidate: unknown,
  ): Promise<ProtectedReadModelResolution> {
    const binding = protectedReadModelBindingV2Schema.safeParse(bindingCandidate);
    const request = protectedReadModelPageRequestSchema.safeParse(requestCandidate);
    if (!binding.success || !request.success) return refused;
    const model = binding.data.key;
    const page: ProtectedReadModelPageRequest = request.data;
    const declared: readonly string[] = protectedReadModelDeclarations[model].filters;
    if (page.groupId !== undefined && !declared.includes("groupId")) return refused;

    try {
      switch (model) {
        case "people":
          if (page.groupId === undefined) return refused;
          return fromOwner(
            model,
            await readers.access.listGroupMemberships(context.session, context.selection, {
              groupId: page.groupId,
              pageSize: page.pageSize,
              ...(page.after === undefined ? {} : { afterMembershipId: page.after }),
            } as ListOrganizationAdministrationMembershipsCommand),
          );
        case "organization_accounts":
          return fromOwner(
            model,
            await readers.access.listOrganizationAccounts(context.session, context.selection, {
              pageSize: page.pageSize,
              ...(page.after === undefined ? {} : { afterOrganizationAccountId: page.after }),
            } as ListOrganizationAccountsCommand),
          );
        case "roles":
          return fromOwner(
            model,
            await readers.access.listRoles(context.session, context.selection, {
              pageSize: page.pageSize,
              ...(page.after === undefined ? {} : { afterRoleId: page.after }),
            } as ListOrganizationAdministrationRolesCommand),
          );
        case "groups":
          return fromOwner(
            model,
            await readers.access.listGroups(context.session, context.selection, {
              pageSize: page.pageSize,
              ...(page.after === undefined ? {} : { afterGroupId: page.after }),
            } as ListOrganizationAdministrationGroupsCommand),
          );
        case "effective_assignments":
          return fromOwner(
            model,
            await readers.access.listRoleAssignments(context.session, context.selection, {
              pageSize: page.pageSize,
              ...(page.after === undefined ? {} : { afterRoleAssignmentId: page.after }),
            } as ListOrganizationAdministrationRoleAssignmentsCommand),
          );
        case "role_activations":
          return fromOwner(
            model,
            await readers.access.listRoleActivations(context.session, context.selection, {
              pageSize: page.pageSize,
              ...(page.after === undefined ? {} : { afterRoleActivationId: page.after }),
            } as ListOrganizationAdministrationRoleActivationsCommand),
          );
        case "delegations":
          return fromOwner(
            model,
            await readers.access.listDelegationAuthorities(context.session, context.selection, {
              pageSize: page.pageSize,
              ...(page.after === undefined ? {} : { afterDelegationAuthorityId: page.after }),
            } as ListOrganizationAdministrationDelegationAuthoritiesCommand),
          );
        case "permissions": {
          // The permission catalogue cursor is an exact owner-qualified
          // reference, not a record cursor, so a continuation cursor is never
          // meaningful here.
          if (page.after !== undefined) return refused;
          return fromOwner(
            model,
            await readers.access.listPermissions(context.session, context.selection, {
              pageSize: page.pageSize,
            } as ListOrganizationAdministrationPermissionsCommand),
          );
        }
        case "organization_invitations":
          return fromOwner(
            model,
            await readers.access.listOrganizationInvitations(context.session, context.selection, {
              pageSize: page.pageSize,
              ...(page.after === undefined ? {} : { afterInvitationId: page.after }),
            } as ListOrganizationInvitationsCommand),
          );
        case "organization_runtime_settings": {
          // One settings document: no cursor, so a continuation cursor is never meaningful here.
          if (page.after !== undefined) return refused;
          const result = await readers.access.readOrganizationRuntimeSettings(
            context.session,
            context.selection,
            {} as ReadOrganizationRuntimeSettingsCommand,
          );
          // Absent settings are the same neutral refusal, never an available-but-empty document.
          return result.kind === "available" && result.value.outcome !== "available"
            ? refused
            : fromOwner(model, result);
        }
        case "tenant_structure": {
          const result = await readers.identity.listTenantHierarchy(context.session, {
            tenantId: context.tenantId,
            page: {
              limit: page.pageSize,
              ...(page.after === undefined ? {} : { after: page.after }),
            },
          } as TenantHierarchyQuery);
          return result.outcome === "available"
            ? { kind: "available", model, value: result.page }
            : refused;
        }
        case "tenants": {
          const result = await readers.identity.listTenants(context.session, {
            limit: page.pageSize,
            ...(page.after === undefined ? {} : { after: page.after }),
          } as TenantLauncherQuery);
          return result.outcome === "available"
            ? { kind: "available", model, value: result.page }
            : refused;
        }
        case "tenant_administrators": {
          // The assignments are the caller's own tenant's, so the tenant is the
          // verified request context's resolved tenant and never page input.
          const result = await readers.identity.listTenantAdministrators(context.session, {
            tenantId: context.tenantId,
            page: {
              limit: page.pageSize,
              ...(page.after === undefined ? {} : { after: page.after }),
            },
          } as TenantAssignmentQuery);
          return result.outcome === "available"
            ? { kind: "available", model, value: result.page }
            : refused;
        }
        case "installed_applications": {
          // Installed applications are read through the ordinary query path from
          // their registered protected projection. The permitted-applications feed
          // still serves them to pages and no owner reader replaces it yet, so this
          // is the same neutral refusal an unknown read model gives, never a page
          // of applications the viewer may not reach.
          return refused;
        }
      }
    } catch {
      return unavailable;
    }
  },
});
