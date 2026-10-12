import {
  platformServiceOperationReleaseSchema,
  protectedOperationDescriptorSchema,
  type PlatformServiceOperationRelease,
  type ProtectedOperationDescriptor,
  type ProtectedOperationReference,
} from "./application-flow-bindings";

const deepFreeze = <Value>(value: Value): Value => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
};

type HistoricalOperation = Readonly<{
  release: PlatformServiceOperationRelease;
  descriptor: ProtectedOperationDescriptor;
}>;

const historicalEntry = (definition: {
  release: {
    serviceId: string;
    operationId: string;
    releaseVersion: string;
    contentFingerprint: string;
    catalogueFingerprint: string;
  };
  descriptor: unknown;
}): HistoricalOperation => {
  const release = platformServiceOperationReleaseSchema.parse(definition.release);
  const descriptor = protectedOperationDescriptorSchema.parse(definition.descriptor);
  if (
    descriptor.operation.owner.kind !== "platform_service" ||
    descriptor.operation.owner.serviceId !== release.serviceId ||
    descriptor.operation.operationId !== release.operationId ||
    descriptor.effect !== "change" ||
    descriptor.expectedRevision !== "required"
  )
    throw new Error("Historical Module operation registration is inconsistent");
  return deepFreeze({ release, descriptor });
};

/**
 * Stored Module validation contract 3.0.0 registration semantics, not current execution targets.
 * These complete descriptors and fingerprints come from protected retirement parent
 * 3743ca03b1e088f6430e1a5e56bc68e8c3da413b, catalogue source blob
 * 13e7d13047d9891680ab137f3aa9641c7e97ec35 and generated fingerprint blob
 * 90a2a4314c3a3bfd72aa42811ed9cd9b4c779660. The content fingerprint hashes the canonical
 * descriptor; the catalogue fingerprint hashes its exact platform-service release identity
 * and content fingerprint. They do not assert a dependency absent from an old Module manifest.
 *
 * The archive is private, parsed once and deeply frozen. Its only projection is an identity
 * predicate used by the separately named stored Module schema. No release or descriptor enters
 * the current operation catalogue, publication dependency selection, or a live/durable executor.
 */
const storedModuleOperationCatalogue = deepFreeze({
  "3.0.0": [
    historicalEntry({
      "release": {
        "serviceId": "e0a60e5a-cb5c-449d-ab9d-4a47ab344e3f",
        "operationId": "4de3ad3d-c6d2-4523-9113-255093526b45",
        "releaseVersion": "1.0.0",
        "contentFingerprint": "sha256:91717c74e833e72181e50269abe845833771a26d0cd3201a70dcb3120254ef09",
        "catalogueFingerprint": "sha256:0d4e918afe06d745bf6debfa9db35fb548c5c35c649f3e838be50b07936aa115"
      },
      "descriptor": {
        "contractVersion": "1.0.0",
        "operation": {
          "owner": {
            "kind": "platform_service",
            "serviceId": "e0a60e5a-cb5c-449d-ab9d-4a47ab344e3f"
          },
          "operationId": "4de3ad3d-c6d2-4523-9113-255093526b45"
        },
        "inputs": {
          "expected_revision": {
            "type": "whole_number",
            "required": true
          },
          "language": {
            "type": "text",
            "required": true
          },
          "time_zone": {
            "type": "text",
            "required": true
          },
          "currency": {
            "type": "text",
            "required": true
          },
          "date_format": {
            "type": "choice",
            "required": true
          },
          "number_format": {
            "type": "choice",
            "required": true
          }
        },
        "outputs": {
          "revision": {
            "type": "whole_number",
            "required": true
          }
        },
        "effect": "change",
        "expectedRevision": "required",
        "confirmation": "required",
        "duplicateProtection": "not_required",
        "safeResults": [
          "committed",
          "refused",
          "conflict",
          "validation",
          "failed"
        ],
        "requiredAuthority": {
          "kind": "permission",
          "permissionId": "c658c254-2884-414a-9012-512c0cfe4b34",
          "key": "platform.organization.runtime_settings.manage"
        }
      }
    }),
    historicalEntry({
      "release": {
        "serviceId": "e0a60e5a-cb5c-449d-ab9d-4a47ab344e3f",
        "operationId": "9116e660-375d-4157-b3be-d0943a1c988a",
        "releaseVersion": "1.0.0",
        "contentFingerprint": "sha256:2230e6c267989319c5b4c9634f3e8bee2f0eb32226e423cda7e9b011d1b60baf",
        "catalogueFingerprint": "sha256:1688ea6fb70729a2b84ebdfe5787355f25dc47052a374c1093e89bf71bdbad7a"
      },
      "descriptor": {
        "contractVersion": "1.0.0",
        "operation": {
          "owner": {
            "kind": "platform_service",
            "serviceId": "e0a60e5a-cb5c-449d-ab9d-4a47ab344e3f"
          },
          "operationId": "9116e660-375d-4157-b3be-d0943a1c988a"
        },
        "inputs": {
          "expected_revision": {
            "type": "whole_number",
            "required": true
          },
          "default_application_root_id": {
            "type": "text",
            "required": false
          }
        },
        "outputs": {
          "default_application_root_id": {
            "type": "text",
            "required": false
          },
          "revision": {
            "type": "whole_number",
            "required": true
          }
        },
        "effect": "change",
        "expectedRevision": "required",
        "confirmation": "required",
        "duplicateProtection": "not_required",
        "safeResults": [
          "committed",
          "refused",
          "conflict",
          "validation",
          "failed"
        ],
        "requiredAuthority": {
          "kind": "permission",
          "permissionId": "c658c254-2884-414a-9012-512c0cfe4b34",
          "key": "platform.organization.runtime_settings.manage"
        }
      }
    }),
  ],
});

const archivedIdentities = new Set<string>();
for (const entry of storedModuleOperationCatalogue["3.0.0"]) {
  const identity = `${entry.release.serviceId}:${entry.release.operationId}`;
  if (archivedIdentities.has(identity))
    throw new Error("Historical Module operation identity is ambiguous");
  archivedIdentities.add(identity);
}

/** Historical Module 3.0.0 validation only; never an execution registration or authority grant. */
export const isHistoricalModuleV3SystemRecordOperation = (
  reference: ProtectedOperationReference,
): boolean => {
  const owner = reference.owner;
  return owner.kind === "platform_service" &&
    storedModuleOperationCatalogue["3.0.0"].some((entry) =>
      entry.release.serviceId === owner.serviceId &&
      entry.release.operationId === reference.operationId &&
      entry.descriptor.expectedRevision === "required",
    );
};
