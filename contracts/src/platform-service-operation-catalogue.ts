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
  release: { operationId: string };
  descriptor: unknown;
}): PlatformServiceOperationCatalogueEntry =>
  deepFreeze({
    key: definition.key,
    name: definition.name,
    release: platformServiceOperationReleaseSchema.parse({
      ...definition.release,
      ...generatedReleaseFingerprints("platformServiceOperations", definition.release.operationId),
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
 * catalogue/catalogue-fingerprints.generated.json, merged in by operation id and never written by
 * hand; the publication catalogue recomputes both when it is created, so a changed descriptor
 * without regenerated fingerprints refuses instead of publishing.
 *
 * Only the terminal, metadata and settings operations the Access services already provide are
 * registered. Nothing here grants, assigns or activates access, so no flow can expand authority.
 */
export const PLATFORM_SERVICE_OPERATIONS = deepFreeze({
  create_group: entry(sources.create_group),
  rename_group: entry(sources.rename_group),
  retire_group: entry(sources.retire_group),
  remove_group_membership: entry(sources.remove_group_membership),
  revise_role_metadata: entry(sources.revise_role_metadata),
  retire_role: entry(sources.retire_role),
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
