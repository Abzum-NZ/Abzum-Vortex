import type { PlatformServiceOperationKey } from "../catalogue/platform-service-operation-catalogue";
import type { ProtectedOperationDescriptor } from "./application-flow-bindings";

type ProtectedOperationMetadata = Readonly<{
  authorityKind: ProtectedOperationDescriptor["requiredAuthority"]["kind"];
  transaction: "read" | "change" | "access_change";
  workflow: "single" | "multi_transaction";
}>;

/** Execution properties shared by the plan compiler and each registered runner. */
export const protectedOperationMetadata = {
  create_group: { authorityKind: "permission", transaction: "access_change", workflow: "single" },
  create_tenant_organization: {
    authorityKind: "tenant_capability",
    transaction: "access_change",
    workflow: "single",
  },
  rename_group: { authorityKind: "permission", transaction: "access_change", workflow: "single" },
  retire_group: { authorityKind: "permission", transaction: "access_change", workflow: "single" },
  remove_group_membership: {
    authorityKind: "permission",
    transaction: "access_change",
    workflow: "single",
  },
  revise_role_metadata: { authorityKind: "permission", transaction: "change", workflow: "single" },
  retire_role: { authorityKind: "permission", transaction: "access_change", workflow: "single" },
  revoke_role_assignment: {
    authorityKind: "permission",
    transaction: "access_change",
    workflow: "single",
  },
  deactivate_role_activation: {
    authorityKind: "permission",
    transaction: "access_change",
    workflow: "single",
  },
  revoke_delegation_authority: {
    authorityKind: "permission",
    transaction: "access_change",
    workflow: "single",
  },
  add_group_membership: {
    authorityKind: "permission",
    transaction: "access_change",
    workflow: "single",
  },
  assign_role_assignment: {
    authorityKind: "permission",
    transaction: "access_change",
    workflow: "single",
  },
  create_custom_role: {
    authorityKind: "permission",
    transaction: "access_change",
    workflow: "single",
  },
  create_custom_role_from_template: {
    authorityKind: "permission",
    transaction: "access_change",
    workflow: "single",
  },
  rename_tenant_organization: {
    authorityKind: "tenant_capability",
    transaction: "access_change",
    workflow: "single",
  },
  reparent_tenant_organization: {
    authorityKind: "tenant_capability",
    transaction: "access_change",
    workflow: "single",
  },
  suspend_tenant_organization: {
    authorityKind: "tenant_capability",
    transaction: "access_change",
    workflow: "single",
  },
  reactivate_tenant_organization: {
    authorityKind: "tenant_capability",
    transaction: "access_change",
    workflow: "single",
  },
  suspend_organization_account: {
    authorityKind: "permission",
    transaction: "access_change",
    workflow: "single",
  },
  reactivate_organization_account: {
    authorityKind: "permission",
    transaction: "access_change",
    workflow: "single",
  },
  close_organization_account: {
    authorityKind: "permission",
    transaction: "access_change",
    workflow: "single",
  },
  create_organization_invitation: {
    authorityKind: "permission",
    transaction: "access_change",
    workflow: "single",
  },
  revoke_organization_invitation: {
    authorityKind: "permission",
    transaction: "change",
    workflow: "single",
  },
  update_own_profile: { authorityKind: "permission", transaction: "change", workflow: "single" },
  read_own_profile: { authorityKind: "permission", transaction: "read", workflow: "single" },
  prepare_role_change_evidence: {
    authorityKind: "permission",
    transaction: "read",
    workflow: "single",
  },
  appoint_organization_steward: {
    authorityKind: "permission",
    transaction: "access_change",
    workflow: "single",
  },
  review_application_installation: {
    authorityKind: "permission",
    transaction: "read",
    workflow: "single",
  },
  install_application: {
    authorityKind: "permission",
    transaction: "change",
    workflow: "multi_transaction",
  },
  upgrade_application: {
    authorityKind: "permission",
    transaction: "change",
    workflow: "multi_transaction",
  },
  grant_delegation_authority: {
    authorityKind: "permission",
    transaction: "access_change",
    workflow: "single",
  },
  review_application_removal: {
    authorityKind: "permission",
    transaction: "read",
    workflow: "single",
  },
  remove_application: {
    authorityKind: "permission",
    transaction: "change",
    workflow: "multi_transaction",
  },
  prepare_role_assignment: { authorityKind: "permission", transaction: "read", workflow: "single" },
} as const satisfies Record<PlatformServiceOperationKey, ProtectedOperationMetadata>;
