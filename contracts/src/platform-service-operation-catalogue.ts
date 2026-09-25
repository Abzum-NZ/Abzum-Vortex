import {
  platformServiceOperationReleaseSchema,
  protectedOperationDescriptorSchema,
  type PlatformServiceOperationRelease,
  type ProtectedOperationDescriptor,
} from "./application-flow-bindings";
import { generatedReleaseFingerprints } from "./catalogue/generated-fingerprints";
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
      ...generatedReleaseFingerprints(
        "platformServiceOperations",
        `${definition.release.serviceId}:${definition.release.operationId}:${definition.release.releaseVersion}`,
      ),
    }),
    descriptor: protectedOperationDescriptorSchema.parse(definition.descriptor),
  });

/**
 * The registered platform-service operations: the one source of the protected operations an
 * Application flow may target through `owner.kind: "platform_service"`. Every entry is a change
 * that runs under the current human's own authority in the owning Access service, which
 * re-authorises it and never accepts an organisation or actor from its caller, so a flow carries
 * only the target record's identity, its expected revision and the new values. Each release is
 * parsed through its contract at module load and deep-frozen. Its content fingerprint is the
 * canonical-JSON SHA-256 of the descriptor and its catalogue fingerprint that of
 * `{ kind: "platform_service_operation", serviceId, operationId, releaseVersion,
 * contentFingerprint }`. The operations live in catalogue/platform-service-operation-catalogue.source.json
 * and `pnpm catalogue:fingerprints` derives both fingerprints from them into
 * catalogue/catalogue-fingerprints.generated.json, merged in by service, operation and release
 * version and never written by hand; the publication catalogue recomputes both when it is created,
 * so a changed descriptor without regenerated fingerprints refuses instead of publishing.
 *
 * Every operation the Access services already provide is registered, including the grant-side
 * assign-role and add-membership operations. Registration never grants authority: each operation
 * re-checks the current actor's authority and refuses any grant that exceeds the actor's own
 * delegated scope inside its owning service transaction, so a flow can never expand access.
 */
export const PLATFORM_SERVICE_OPERATIONS = deepFreeze({
  create_group: entry(sources.create_group),
  rename_group: entry(sources.rename_group),
  retire_group: entry(sources.retire_group),
  add_group_membership: entry(sources.add_group_membership),
  remove_group_membership: entry(sources.remove_group_membership),
  revise_role_metadata: entry(sources.revise_role_metadata),
  retire_role: entry(sources.retire_role),
  assign_role_assignment: entry(sources.assign_role_assignment),
  revoke_role_assignment: entry(sources.revoke_role_assignment),
  deactivate_role_activation: entry(sources.deactivate_role_activation),
  revoke_delegation_authority: entry(sources.revoke_delegation_authority),
  update_runtime_settings: entry(sources.update_runtime_settings),
  set_default_application: entry(sources.set_default_application),
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
