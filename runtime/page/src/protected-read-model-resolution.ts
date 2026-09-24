import "server-only";

import {
  protectedReadModelBindingV2Schema,
  protectedReadModelDeclarations,
  protectedReadModelPageRequestSchema,
  type IdentitySession,
  type ListOrganizationAccountsCommand,
  type ListOrganizationAccountsResult,
  type ListOrganizationAdministrationGroupsCommand,
  type ListOrganizationAdministrationGroupsResult,
  type ListOrganizationAdministrationMembershipsCommand,
  type ListOrganizationAdministrationMembershipsResult,
  type ListOrganizationAdministrationRoleAssignmentsCommand,
  type ListOrganizationAdministrationRoleAssignmentsResult,
  type ListOrganizationAdministrationRolesCommand,
  type ListOrganizationAdministrationRolesResult,
  type OrganizationSelectionCandidate,
  type ProtectedReadModelKey,
  type ProtectedReadModelPageRequest,
  type TenantHierarchyQuery,
  type TenantHierarchyResult,
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
    listRoleAssignments(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      command: ListOrganizationAdministrationRoleAssignmentsCommand,
    ): Promise<OwnerResult<ListOrganizationAdministrationRoleAssignmentsResult>>;
    listOrganizationAccounts(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      command: ListOrganizationAccountsCommand,
    ): Promise<OwnerResult<ListOrganizationAccountsResult>>;
  }>;
  identity: Readonly<{
    listTenantHierarchy(
      session: IdentitySession,
      query: TenantHierarchyQuery,
    ): Promise<TenantHierarchyResult>;
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
      }
    } catch {
      return unavailable;
    }
  },
});
