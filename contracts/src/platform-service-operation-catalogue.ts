import {
  platformServiceOperationReleaseSchema,
  protectedOperationDescriptorSchema,
  type PlatformServiceOperationRelease,
  type ProtectedOperationDescriptor,
} from "./application-flow-bindings";

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
  release: unknown;
  descriptor: unknown;
}): PlatformServiceOperationCatalogueEntry =>
  deepFreeze({
    key: definition.key,
    name: definition.name,
    release: platformServiceOperationReleaseSchema.parse(definition.release),
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
 * contentFingerprint }`; the publication catalogue recomputes both when it is created, so a
 * changed descriptor without a new release and fingerprints refuses instead of publishing.
 *
 * Only the terminal, metadata and settings operations the Access services already provide are
 * registered. Nothing here grants, assigns or activates access, so no flow can expand authority.
 */
export const PLATFORM_SERVICE_OPERATIONS = deepFreeze({
  create_group: entry({
    key: "create_group",
    name: "Create group",
    release: {
      serviceId: "e0a47e3c-f7f4-4b9b-870a-193b54ba9aa8",
      operationId: "8e6e6659-85c5-47d8-a8a1-24c3e2faf020",
      releaseVersion: "1.0.0",
      contentFingerprint: "sha256:4246bfcff62a658555901cc0423762e8e02763d2626dfe5d6109c1971b85f9fe",
      catalogueFingerprint: "sha256:5cb2aa159fa49263623b775de67c08099fcb44cf97e72a33e5f59765bc7c59a6",
    },
    descriptor: {
      "contractVersion": "1.0.0",
      "operation": {
        "owner": {
          "kind": "platform_service",
          "serviceId": "e0a47e3c-f7f4-4b9b-870a-193b54ba9aa8"
        },
        "operationId": "8e6e6659-85c5-47d8-a8a1-24c3e2faf020"
      },
      "inputs": {
        "group_key": {
          "type": "text",
          "required": true
        },
        "label": {
          "type": "text",
          "required": true
        }
      },
      "outputs": {
        "group_id": {
          "type": "text",
          "required": true
        },
        "revision": {
          "type": "whole_number",
          "required": true
        },
        "access_version": {
          "type": "whole_number",
          "required": true
        }
      },
      "permission": {
        "permissionId": "6185dc64-464b-4776-97dc-c64a6f299550",
        "key": "platform.organization.groups.manage"
      },
      "effect": "change",
      "expectedRevision": "not_required",
      "confirmation": "required",
      "duplicateProtection": "not_required",
      "safeResults": [
        "committed",
        "refused",
        "validation",
        "failed"
      ]
    },
  }),
  rename_group: entry({
    key: "rename_group",
    name: "Rename group",
    release: {
      serviceId: "e0a47e3c-f7f4-4b9b-870a-193b54ba9aa8",
      operationId: "fa60026c-8a50-4607-b357-20bb3eed7321",
      releaseVersion: "1.0.0",
      contentFingerprint: "sha256:7bd3c4b06f9609d9633babde06bbc3b5c9f34bc4e043b14492c5607b9da619af",
      catalogueFingerprint: "sha256:0c19752f7c5e69a380c85baaf518f9a4fe8f00ce171c95e05e809117d3661e4e",
    },
    descriptor: {
      "contractVersion": "1.0.0",
      "operation": {
        "owner": {
          "kind": "platform_service",
          "serviceId": "e0a47e3c-f7f4-4b9b-870a-193b54ba9aa8"
        },
        "operationId": "fa60026c-8a50-4607-b357-20bb3eed7321"
      },
      "inputs": {
        "group_id": {
          "type": "text",
          "required": true
        },
        "expected_group_revision": {
          "type": "whole_number",
          "required": true
        },
        "label": {
          "type": "text",
          "required": true
        }
      },
      "outputs": {
        "group_id": {
          "type": "text",
          "required": true
        },
        "revision": {
          "type": "whole_number",
          "required": true
        },
        "access_version": {
          "type": "whole_number",
          "required": true
        }
      },
      "permission": {
        "permissionId": "6185dc64-464b-4776-97dc-c64a6f299550",
        "key": "platform.organization.groups.manage"
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
      ]
    },
  }),
  retire_group: entry({
    key: "retire_group",
    name: "Retire group",
    release: {
      serviceId: "e0a47e3c-f7f4-4b9b-870a-193b54ba9aa8",
      operationId: "3ca55b1c-66e4-43f2-9a38-f756e3b4cb6d",
      releaseVersion: "1.0.0",
      contentFingerprint: "sha256:f2c5a19235857deb31349349db1e96700a4acc62f0e569ec771980020b223d9f",
      catalogueFingerprint: "sha256:a199cca8ed878a09d75721b61b0ed0ecfa7310b46b7dae7d4aecb408766777ec",
    },
    descriptor: {
      "contractVersion": "1.0.0",
      "operation": {
        "owner": {
          "kind": "platform_service",
          "serviceId": "e0a47e3c-f7f4-4b9b-870a-193b54ba9aa8"
        },
        "operationId": "3ca55b1c-66e4-43f2-9a38-f756e3b4cb6d"
      },
      "inputs": {
        "group_id": {
          "type": "text",
          "required": true
        },
        "expected_group_revision": {
          "type": "whole_number",
          "required": true
        }
      },
      "outputs": {
        "group_id": {
          "type": "text",
          "required": true
        },
        "revision": {
          "type": "whole_number",
          "required": true
        },
        "access_version": {
          "type": "whole_number",
          "required": true
        }
      },
      "permission": {
        "permissionId": "6185dc64-464b-4776-97dc-c64a6f299550",
        "key": "platform.organization.groups.manage"
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
      ]
    },
  }),
  remove_group_membership: entry({
    key: "remove_group_membership",
    name: "Remove group membership",
    release: {
      serviceId: "e0a47e3c-f7f4-4b9b-870a-193b54ba9aa8",
      operationId: "04e33773-ea8d-4dfe-9003-310e18b8d5db",
      releaseVersion: "1.0.0",
      contentFingerprint: "sha256:231ffb65214c6dd87bc5eca0492d31a8d06a39d98751f96165ce255d049eff62",
      catalogueFingerprint: "sha256:2c350be1bbd5cd09ea26dc8e62880dfb58d66d1a7dbfb4ac4880acdd6ec95010",
    },
    descriptor: {
      "contractVersion": "1.0.0",
      "operation": {
        "owner": {
          "kind": "platform_service",
          "serviceId": "e0a47e3c-f7f4-4b9b-870a-193b54ba9aa8"
        },
        "operationId": "04e33773-ea8d-4dfe-9003-310e18b8d5db"
      },
      "inputs": {
        "membership_id": {
          "type": "text",
          "required": true
        },
        "expected_membership_revision": {
          "type": "whole_number",
          "required": true
        }
      },
      "outputs": {
        "membership_id": {
          "type": "text",
          "required": true
        },
        "revision": {
          "type": "whole_number",
          "required": true
        },
        "access_version": {
          "type": "whole_number",
          "required": true
        }
      },
      "permission": {
        "permissionId": "6185dc64-464b-4776-97dc-c64a6f299550",
        "key": "platform.organization.groups.manage"
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
      ]
    },
  }),
  revise_role_metadata: entry({
    key: "revise_role_metadata",
    name: "Revise role details",
    release: {
      serviceId: "e0a47e3c-f7f4-4b9b-870a-193b54ba9aa8",
      operationId: "8afbef77-caa4-45f3-8e69-34e527152d93",
      releaseVersion: "1.0.0",
      contentFingerprint: "sha256:84472a53f6af2ef19de57c3a30d068187619a810541354e9cd9c50830924b5c5",
      catalogueFingerprint: "sha256:ed10af5ed17d3544ac2cecf16e66bff2ec9eec976f031993555baf40a9b275cc",
    },
    descriptor: {
      "contractVersion": "1.0.0",
      "operation": {
        "owner": {
          "kind": "platform_service",
          "serviceId": "e0a47e3c-f7f4-4b9b-870a-193b54ba9aa8"
        },
        "operationId": "8afbef77-caa4-45f3-8e69-34e527152d93"
      },
      "inputs": {
        "role_id": {
          "type": "text",
          "required": true
        },
        "expected_role_revision": {
          "type": "whole_number",
          "required": true
        },
        "label": {
          "type": "text",
          "required": true
        },
        "description": {
          "type": "text",
          "required": true
        }
      },
      "outputs": {
        "role_id": {
          "type": "text",
          "required": true
        },
        "revision": {
          "type": "whole_number",
          "required": true
        },
        "access_version": {
          "type": "whole_number",
          "required": true
        }
      },
      "permission": {
        "permissionId": "87c96495-c806-4692-9bc2-250ddb10613c",
        "key": "platform.organization.roles.manage"
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
      ]
    },
  }),
  retire_role: entry({
    key: "retire_role",
    name: "Retire role",
    release: {
      serviceId: "e0a47e3c-f7f4-4b9b-870a-193b54ba9aa8",
      operationId: "bdbd9b70-f587-4522-bb0f-6e81173e69d4",
      releaseVersion: "1.0.0",
      contentFingerprint: "sha256:9ace9042c73306a65bebd64ff597423b854570956145a096ee4d82ecc5975ed1",
      catalogueFingerprint: "sha256:12c0295763562decdbac44bdf923642539a9daada3a3a59d2d516e8bd888bf86",
    },
    descriptor: {
      "contractVersion": "1.0.0",
      "operation": {
        "owner": {
          "kind": "platform_service",
          "serviceId": "e0a47e3c-f7f4-4b9b-870a-193b54ba9aa8"
        },
        "operationId": "bdbd9b70-f587-4522-bb0f-6e81173e69d4"
      },
      "inputs": {
        "role_id": {
          "type": "text",
          "required": true
        },
        "expected_role_revision": {
          "type": "whole_number",
          "required": true
        }
      },
      "outputs": {
        "role_id": {
          "type": "text",
          "required": true
        },
        "revision": {
          "type": "whole_number",
          "required": true
        },
        "access_version": {
          "type": "whole_number",
          "required": true
        }
      },
      "permission": {
        "permissionId": "87c96495-c806-4692-9bc2-250ddb10613c",
        "key": "platform.organization.roles.manage"
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
      ]
    },
  }),
  revoke_role_assignment: entry({
    key: "revoke_role_assignment",
    name: "Revoke role assignment",
    release: {
      serviceId: "e0a47e3c-f7f4-4b9b-870a-193b54ba9aa8",
      operationId: "199901c1-3d3e-4243-9912-1ebcf743a4c4",
      releaseVersion: "1.0.0",
      contentFingerprint: "sha256:7476993df6cd3d9fc17c2d88c2309b2ee6f83546136e7e2ad1be4bf57c550d44",
      catalogueFingerprint: "sha256:4122a7252db0409a94e68502490afbb9c3325508b19b12d376f3b555358db0f3",
    },
    descriptor: {
      "contractVersion": "1.0.0",
      "operation": {
        "owner": {
          "kind": "platform_service",
          "serviceId": "e0a47e3c-f7f4-4b9b-870a-193b54ba9aa8"
        },
        "operationId": "199901c1-3d3e-4243-9912-1ebcf743a4c4"
      },
      "inputs": {
        "role_assignment_id": {
          "type": "text",
          "required": true
        },
        "expected_assignment_revision": {
          "type": "whole_number",
          "required": true
        }
      },
      "outputs": {
        "role_assignment_id": {
          "type": "text",
          "required": true
        },
        "revision": {
          "type": "whole_number",
          "required": true
        },
        "access_version": {
          "type": "whole_number",
          "required": true
        }
      },
      "permission": {
        "permissionId": "156d01f3-8f80-45fb-8fc8-b31c47dbb1df",
        "key": "platform.organization.assignments.manage"
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
      ]
    },
  }),
  deactivate_role_activation: entry({
    key: "deactivate_role_activation",
    name: "Deactivate role activation",
    release: {
      serviceId: "e0a47e3c-f7f4-4b9b-870a-193b54ba9aa8",
      operationId: "868c640d-4d9f-4f0f-b0fc-268af1764a43",
      releaseVersion: "1.0.0",
      contentFingerprint: "sha256:3f397221c0a59daed70a42626baed5b1967a23afeeb3a7a7ff2998ce5258f125",
      catalogueFingerprint: "sha256:c619795601d21453a30b86fa3e10c8c9694607810f1428f0e90c9a9c75d606e5",
    },
    descriptor: {
      "contractVersion": "1.0.0",
      "operation": {
        "owner": {
          "kind": "platform_service",
          "serviceId": "e0a47e3c-f7f4-4b9b-870a-193b54ba9aa8"
        },
        "operationId": "868c640d-4d9f-4f0f-b0fc-268af1764a43"
      },
      "inputs": {
        "role_activation_id": {
          "type": "text",
          "required": true
        },
        "expected_activation_revision": {
          "type": "whole_number",
          "required": true
        }
      },
      "outputs": {
        "role_activation_id": {
          "type": "text",
          "required": true
        },
        "revision": {
          "type": "whole_number",
          "required": true
        },
        "access_version": {
          "type": "whole_number",
          "required": true
        }
      },
      "permission": {
        "permissionId": "156d01f3-8f80-45fb-8fc8-b31c47dbb1df",
        "key": "platform.organization.assignments.manage"
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
      ]
    },
  }),
  revoke_delegation_authority: entry({
    key: "revoke_delegation_authority",
    name: "Revoke delegation authority",
    release: {
      serviceId: "e0a47e3c-f7f4-4b9b-870a-193b54ba9aa8",
      operationId: "d476aab8-f06d-416b-a28f-fb4a7c4a8729",
      releaseVersion: "1.0.0",
      contentFingerprint: "sha256:8d31c1472c1a0aeae59f06efb438af65564bbd3c7b2da02c6c1da0763eb686bd",
      catalogueFingerprint: "sha256:9c9dc17b63488ff5b91aba553a5b7258872740020fd0d9d0baadcff060acf779",
    },
    descriptor: {
      "contractVersion": "1.0.0",
      "operation": {
        "owner": {
          "kind": "platform_service",
          "serviceId": "e0a47e3c-f7f4-4b9b-870a-193b54ba9aa8"
        },
        "operationId": "d476aab8-f06d-416b-a28f-fb4a7c4a8729"
      },
      "inputs": {
        "delegation_authority_id": {
          "type": "text",
          "required": true
        },
        "expected_delegation_revision": {
          "type": "whole_number",
          "required": true
        }
      },
      "outputs": {
        "delegation_authority_id": {
          "type": "text",
          "required": true
        },
        "revision": {
          "type": "whole_number",
          "required": true
        },
        "access_version": {
          "type": "whole_number",
          "required": true
        }
      },
      "permission": {
        "permissionId": "156d01f3-8f80-45fb-8fc8-b31c47dbb1df",
        "key": "platform.organization.assignments.manage"
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
      ]
    },
  }),
  update_runtime_settings: entry({
    key: "update_runtime_settings",
    name: "Update runtime settings",
    release: {
      serviceId: "e0a60e5a-cb5c-449d-ab9d-4a47ab344e3f",
      operationId: "4de3ad3d-c6d2-4523-9113-255093526b45",
      releaseVersion: "1.0.0",
      contentFingerprint: "sha256:c0ef510e9d8e2df159514fcbf9621fb3804a239c3227b867f4073864e8d1ede3",
      catalogueFingerprint: "sha256:a080c060633629799f0023e97f76a2cdf4c0d6932837877dbafce3281ef12b36",
    },
    descriptor: {
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
      "permission": {
        "permissionId": "c658c254-2884-414a-9012-512c0cfe4b34",
        "key": "platform.organization.runtime_settings.manage"
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
      ]
    },
  }),
  set_default_application: entry({
    key: "set_default_application",
    name: "Set default application",
    release: {
      serviceId: "e0a60e5a-cb5c-449d-ab9d-4a47ab344e3f",
      operationId: "9116e660-375d-4157-b3be-d0943a1c988a",
      releaseVersion: "1.0.0",
      contentFingerprint: "sha256:b9663975654126162032cde7e2413626777ff53e13546e832ea53a5788fca0f0",
      catalogueFingerprint: "sha256:fa5b0dfd127f082cc11abce4c8523311556c2c84fbdf5d5763bb6c0f46dbf1f2",
    },
    descriptor: {
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
        },
        "changed": {
          "type": "yes_no",
          "required": true
        }
      },
      "permission": {
        "permissionId": "c658c254-2884-414a-9012-512c0cfe4b34",
        "key": "platform.organization.runtime_settings.manage"
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
      ]
    },
  }),
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
 * Authors the current-user Frontend Flow that reaches one registered operation. The flow declares
 * exactly the operation's typed inputs, hands each straight to its Action node, routes every result
 * the operation reports to its own return node and returns the confirmed result's typed outputs.
 * Nothing about the organisation, account or authority is an input: the owning service derives them
 * from the request context.
 */
export const platformServiceOperationFlowSource = (operation: PlatformServiceOperationCatalogueEntry) => {
  const { descriptor, release } = operation;
  const declaration = ({ type, required }: { type: string; required: boolean }) => ({
    type,
    required,
  });
  const inputs = Object.fromEntries(
    Object.entries(descriptor.inputs).map(([key, value]) => [key, declaration(value)]),
  );
  const outputs = Object.fromEntries(
    Object.entries(descriptor.outputs).map(([key, value]) => [key, declaration(value)]),
  );
  const outcomeNodes = descriptor.safeResults.map((outcome) => ({
    id: `node_${outcome}`,
    key: `return_${outcome}`,
    kind: "return" as const,
    outcome,
    results:
      outcome === descriptor.safeResults[0]
        ? Object.fromEntries(
            Object.keys(outputs).map((key) => [
              key,
              { source: "node_output" as const, node: "node_operation", output: key },
            ]),
          )
        : {},
  }));
  return {
    id: `flow_${operation.key}`,
    key: operation.key,
    name: operation.name,
    run_as: "current_user" as const,
    inputs,
    outputs: Object.fromEntries(
      Object.entries(outputs).map(([key, value]) => [key, { ...value, required: false }]),
    ),
    variables: {},
    nodes: [
      { id: "node_start", key: "start", kind: "start" as const, outputs: inputs },
      {
        id: "node_operation",
        key: "operation",
        kind: "action" as const,
        target: {
          kind: "protected_operation" as const,
          operation: descriptor.operation,
          release_version: release.releaseVersion,
        },
        inputs: Object.fromEntries(
          Object.entries(inputs).map(([key, value]) => [
            key,
            { type: value.type, value: { source: "flow_input" as const, input: key } },
          ]),
        ),
        outputs: Object.fromEntries(
          Object.entries(outputs).map(([key, value]) => [key, { ...value, required: false }]),
        ),
        results: Object.fromEntries(
          Object.entries(outputs).map(([key, value]) => [key, { output: key, type: value.type }]),
        ),
      },
      ...outcomeNodes,
    ],
    edges: [
      { id: "edge_start", from_node: "node_start", to_node: "node_operation" },
      ...descriptor.safeResults.map((outcome) => ({
        id: `edge_${outcome}`,
        from_node: "node_operation",
        to_node: `node_${outcome}`,
        outcome,
      })),
    ],
  };
};

/**
 * Authors the component binding that starts the operation's flow from one control's `action`
 * event. Every flow input is read from the named form's input of the same key, and the confirmed
 * outputs are mapped back by key, so the control carries no operation, authority or literal.
 */
export const platformServiceOperationBindingSource = (
  operation: PlatformServiceOperationCatalogueEntry,
  placement: Readonly<{ control: string; form: string; eventId: string }>,
) => ({
  id: `binding_${operation.key}`,
  control: placement.control,
  event_id: placement.eventId,
  event: "action" as const,
  flow: { kind: "application_owned" as const, flow: `flow_${operation.key}` },
  inputs: Object.fromEntries(
    Object.entries(operation.descriptor.inputs).map(([key, value]) => [
      key,
      {
        type: value.type,
        value: { source: "form_input" as const, form: placement.form, input: key },
      },
    ]),
  ),
  results: Object.fromEntries(
    Object.entries(operation.descriptor.outputs).map(([key, value]) => [
      key,
      { output: key, type: value.type },
    ]),
  ),
  declared_effects: ["change" as const],
});
