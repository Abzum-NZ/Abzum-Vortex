import {
  platformServiceOperationReleaseSchema,
  protectedOperationDescriptorSchema,
  type PlatformServiceOperationRelease,
  type ProtectedOperationDescriptor,
} from "../definition/application-flow-bindings";
import { platformServiceOperationReleaseContentHash } from "../definition/catalogue-release-content-hashes";
import sources from "./catalogue/platform-service-operation-catalogue.source.json";

const deepFreeze = <Value>(value: Value): Value => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
};

/**
 * One registered platform-service operation: its exact immutable release evidence and the typed
 * descriptor that release pins. `key` and `name` only help authors name flows and controls; they
 * are never identity. Identity is the service, operation and release version.
 */
export type PlatformServiceOperationCatalogueEntry = Readonly<{
  key: string;
  name: string;
  release: PlatformServiceOperationRelease;
  descriptor: ProtectedOperationDescriptor;
}>;

const entry = (definition: {
  key: string;
  name: string;
  release: { serviceId: string; operationId: string; releaseVersion: string };
  descriptor: unknown;
}): PlatformServiceOperationCatalogueEntry =>
  deepFreeze({
    key: definition.key,
    name: definition.name,
    release: platformServiceOperationReleaseSchema.parse({
      ...definition.release,
      ...platformServiceOperationReleaseContentHash(definition.descriptor),
    }),
    descriptor: protectedOperationDescriptorSchema.parse(definition.descriptor),
  });

/**
 * The registered platform-service operations: the one source of the protected operations an
 * Application flow may target through `owner.kind: "platform_service"`. Every entry is a change
 * that runs under the current human's own authority in the owning Access service, which
 * re-authorises it and never accepts an organisation or actor from its caller, so a flow carries
 * only the target record's identity, its expected revision and the new values. Each release is
 * parsed through its contract at module load and deep-frozen. Its content hash is the canonical-JSON
 * SHA-256 of the descriptor, computed once as the catalogue loads. The publication catalogue
 * recomputes it when validating a release, so a changed descriptor without a new release refuses.
 *
 * Access and Identity operations are registered here, including the grant-side assign-role and
 * add-membership operations, role creation, template acceptance and preparation of an existing
 * Application role revision. Registration never grants authority: each operation re-checks the
 * current actor's authority in its owning service transaction. A flow cannot expand access through
 * registration. Authority-changing operations carry prepared role-change evidence. The owning
 * service re-verifies it before the database re-applies the affected-assignment review, explicit
 * acceptance evidence and permanent-steward safeguard. The installation service registers the
 * application catalogue's review, first install and upgrade, the only human path to install or
 * upgrade an application; they re-prove installation authority in their own transactions.
 */
export const PLATFORM_SERVICE_OPERATIONS = deepFreeze({
  create_connection_instance: entry(sources.create_connection_instance),
  edit_connection_instance: entry(sources.edit_connection_instance),
  revoke_connection_instance: entry(sources.revoke_connection_instance),
  health_check_connection_instance: entry(sources.health_check_connection_instance),
  create_group: entry(sources.create_group),
  create_tenant_organization: entry(sources.create_tenant_organization),
  rename_group: entry(sources.rename_group),
  retire_group: entry(sources.retire_group),
  add_group_membership: entry(sources.add_group_membership),
  remove_group_membership: entry(sources.remove_group_membership),
  revise_role_metadata: entry(sources.revise_role_metadata),
  retire_role: entry(sources.retire_role),
  prepare_role_change_evidence: entry(sources.prepare_role_change_evidence),
  create_custom_role: entry(sources.create_custom_role),
  create_custom_role_from_template: entry(sources.create_custom_role_from_template),
  assign_role_assignment: entry(sources.assign_role_assignment),
  prepare_role_assignment: entry(sources.prepare_role_assignment),
  revoke_role_assignment: entry(sources.revoke_role_assignment),
  deactivate_role_activation: entry(sources.deactivate_role_activation),
  revoke_delegation_authority: entry(sources.revoke_delegation_authority),
  grant_delegation_authority: entry(sources.grant_delegation_authority),
  rename_tenant_organization: entry(sources.rename_tenant_organization),
  reparent_tenant_organization: entry(sources.reparent_tenant_organization),
  suspend_tenant_organization: entry(sources.suspend_tenant_organization),
  reactivate_tenant_organization: entry(sources.reactivate_tenant_organization),
  suspend_organization_account: entry(sources.suspend_organization_account),
  reactivate_organization_account: entry(sources.reactivate_organization_account),
  close_organization_account: entry(sources.close_organization_account),
  read_own_profile: entry(sources.read_own_profile),
  update_own_profile: entry(sources.update_own_profile),
  create_organization_invitation: entry(sources.create_organization_invitation),
  revoke_organization_invitation: entry(sources.revoke_organization_invitation),
  appoint_organization_steward: entry(sources.appoint_organization_steward),
  review_application_installation: entry(sources.review_application_installation),
  install_application: entry(sources.install_application),
  upgrade_application: entry(sources.upgrade_application),
  review_application_removal: entry(sources.review_application_removal),
  remove_application: entry(sources.remove_application),
});

/** Every registered release, in registration order, for the publication catalogue. */
export const PLATFORM_SERVICE_OPERATION_RELEASES: readonly PlatformServiceOperationRelease[] =
  deepFreeze(Object.values(PLATFORM_SERVICE_OPERATIONS).map((operation) => operation.release));

export type PlatformServiceOperationKey = keyof typeof PLATFORM_SERVICE_OPERATIONS;

/** The registered entry for one exact release, or undefined; nothing is resolved by name. */
export const findPlatformServiceOperation = (
  serviceId: string,
  operationId: string,
  releaseVersion: string,
): PlatformServiceOperationCatalogueEntry | undefined =>
  Object.values(PLATFORM_SERVICE_OPERATIONS).find(
    (operation) =>
      operation.release.serviceId === serviceId &&
      operation.release.operationId === operationId &&
      operation.release.releaseVersion === releaseVersion,
  );

/**
 * The readable key a Call protected operation task uses for a registered platform-service
 * operation: the operation's own key under the platform namespace. A named action of a Module is
 * called by the action's own namespaced key, so neither is ever chosen by a release or an id.
 */
export const platformOperationKey = (operationKey: string): string => `platform.${operationKey}`;
