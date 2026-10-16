import type { ApplicationContent, ModuleContent } from "../../schema";
import { canonicalJson } from "../canonical-json-definition";
import { refuseVersionImpact } from "../version-impact-error";
import { type RecordValue, asRecord, sorted } from "./shared";
import { flattenNavigation } from "./application-shared-contents";

export const blockDependencyIdentity = (item: RecordValue): string =>
  `${String(item.blockId)}@${String(item.releaseVersion)}`;

const normaliseField = (field: RecordValue): RecordValue => ({
  ...field,
  ...(field.type === "web_address"
    ? {
        settings: {
          ...asRecord(field.settings),
          allowedSchemes: sorted(
            (asRecord(field.settings).allowedSchemes as unknown[] | undefined) ?? ["https"],
          ),
        },
      }
    : {}),
});

const normaliseActionInput = (input: RecordValue): RecordValue => {
  const { validation, ...withoutValidation } = input;
  const hasValidation = validation !== undefined && Object.keys(asRecord(validation)).length > 0;
  return {
    ...withoutValidation,
    ...(hasValidation ? { validation } : {}),
    ...(input.type === "record_reference"
      ? { recordTypes: sorted(input.recordTypes as unknown[]) }
      : {}),
  };
};

const normaliseAction = (action: RecordValue): RecordValue => ({
  ...action,
  inputs: (action.inputs as RecordValue[]).map(normaliseActionInput),
});

const normaliseRecordType = (recordType: RecordValue): RecordValue => ({
  ...recordType,
  fields: sorted((recordType.fields as RecordValue[]).map(normaliseField), "fieldId"),
  relationships: sorted(recordType.relationships as unknown[], "relationshipId"),
  standardActions: sorted(recordType.standardActions as unknown[]),
  customActionIds: sorted(recordType.customActionIds as unknown[]),
});

/**
 * A Module release version moves with the Application that publishes it, so a pinned release
 * version is not itself a change: the pinned Module's own content changes carry the impact.
 */
const withoutPinnedVersion = (entries: unknown[]): RecordValue[] =>
  (entries as RecordValue[]).map((entry) => {
    const { resolvedVersion, version, ...rest } = entry;
    void resolvedVersion;
    return asRecord(version).selection === "exact" ? rest : { ...rest, version };
  });

export const normaliseModuleContent = <T extends ModuleContent>(content: T): T => {
  const value = asRecord(content);
  return {
    ...value,
    dependencies: sorted(withoutPinnedVersion(value.dependencies as unknown[]), "moduleRootId"),
    recordTypes: sorted(
      (value.recordTypes as RecordValue[]).map(normaliseRecordType),
      "recordTypeId",
    ),
    permissions: sorted(value.permissions as unknown[], "permissionId"),
    actions: sorted((value.actions as RecordValue[]).map(normaliseAction), "actionId"),
    events: sorted(
      (value.events as RecordValue[]).map((event) => ({
        ...event,
        carriedFieldIds: sorted(event.carriedFieldIds as unknown[]),
      })),
      "eventId",
    ),
    rules: sorted(value.rules as unknown[], "ruleId"),
    // Superseded Module contents carry no flows.
    ...(value.flows === undefined ? {} : { flows: sorted(value.flows as unknown[], "id") }),
    sharingConditions: sorted(
      (value.sharingConditions as RecordValue[]).map((condition) => {
        const normalised: RecordValue = {
          ...condition,
          declaredFieldIds: sorted(condition.declaredFieldIds as unknown[]),
        };
        delete normalised.publishedRevision;
        delete normalised.contractFingerprint;
        return normalised;
      }),
      "conditionId",
    ),
    extensionPoints: sorted(
      (value.extensionPoints as RecordValue[]).map((point) => ({
        ...point,
        accepts: sorted(point.accepts as unknown[]),
      })),
      "extensionPointId",
    ),
    // Superseded Module contents carry no contributions. Their order is never meaningful, so the
    // collection is ordered by the contribution identity the compiler assigned.
    ...(value.contributions === undefined
      ? {}
      : { contributions: sorted(value.contributions as unknown[], "contributionId") }),
    // Superseded Module contents carry no queries. Ordering inside one query is meaningful, so
    // only the collection itself is ordered; its typed inputs share the Action input shape.
    ...(value.queries === undefined
      ? {}
      : {
          queries: sorted(
            (value.queries as RecordValue[]).map((query) => ({
              ...query,
              inputs: (query.inputs as RecordValue[]).map(normaliseActionInput),
            })),
            "queryId",
          ),
        }),
  } as T;
};

/** Canonical ordering for the definition-wide fields every Application release shares. */
export const normaliseApplicationSharedContent = (content: ApplicationContent): RecordValue => {
  const value = asRecord(structuredClone(content));
  return {
    ...value,
    moduleBindings: sorted(
      withoutPinnedVersion(value.moduleBindings as unknown[]),
      "moduleRootId",
    ),
    experiences: sorted((value.experiences as unknown[] | undefined) ?? [], "state"),
    roles: sorted(
      (value.roles as RecordValue[]).map((role) => ({
        ...role,
        permissionKeys: sorted(role.permissionKeys as unknown[]),
      })),
      "roleId",
    ),
    queries: sorted(value.queries as unknown[], "queryId"),
    permissions: sorted(value.permissions as unknown[], "permissionId"),
    pipelines: sorted(value.pipelines as unknown[], "pipelineId"),
    actions: sorted((value.actions as RecordValue[]).map(normaliseAction), "actionId"),
    events: sorted(
      (value.events as RecordValue[]).map((event) => ({
        ...event,
        carriedFieldIds: sorted(event.carriedFieldIds as unknown[]),
      })),
      "eventId",
    ),
    connectionBindings: sorted(
      (value.connectionBindings as RecordValue[]).map((binding) => ({
        ...binding,
        requiredOperationKeys: sorted(binding.requiredOperationKeys as unknown[]),
      })),
      "bindingId",
    ),
    interfaces: sorted(
      (value.interfaces as RecordValue[]).map((definition) => ({
        ...definition,
        operations: sorted(
          (definition.operations as RecordValue[]).map((operation) => ({
            ...operation,
            errorCodes: sorted(operation.errorCodes as unknown[]),
          })),
          "operationId",
        ),
      })),
      "interfaceId",
    ),
    publicAddresses: sorted(value.publicAddresses as unknown[], "addressId"),
    flows: sorted(value.flows as unknown[], "id"),
    flowBindings: sorted(value.flowBindings as RecordValue[], "bindingId"),
  };
};

export const assertUnique = (
  values: RecordValue[],
  key: string | ((value: RecordValue) => string),
): void => {
  const identities = values.map((value) =>
    typeof key === "function" ? key(value) : String(value[key]),
  );
  if (new Set(identities).size !== identities.length)
    refuseVersionImpact("ambiguous_component_identity");
};

export const assertUniqueValues = (values: unknown[]): void => {
  const identities = values.map((value) => canonicalJson(value));
  if (new Set(identities).size !== identities.length)
    refuseVersionImpact("ambiguous_component_identity");
};

export const currencyConfiguration = (settings: RecordValue): RecordValue => ({
  currencyMode: settings.currencyMode,
  ...(settings.currency === undefined ? {} : { currency: settings.currency }),
});

/** Typed inputs share one shape wherever an Action or a Module query declares them. */
const assertUnambiguousTypedInputs = (inputs: RecordValue[]): void => {
  assertUnique(inputs, "key");
  for (const input of inputs) {
    if (input.type === "record_reference") assertUniqueValues(input.recordTypes as unknown[]);
    const validation = input.validation;
    if (
      input.type === "formatted_text" &&
      validation !== undefined &&
      Array.isArray(asRecord(validation).allowedBlocks)
    )
      assertUniqueValues(asRecord(validation).allowedBlocks as unknown[]);
  }
};

export const assertUnambiguousModuleContent = (content: unknown): void => {
  const value = asRecord(content);
  for (const [collection, key] of [
    ["dependencies", "moduleRootId"],
    ["recordTypes", "recordTypeId"],
    ["permissions", "permissionId"],
    ["actions", "actionId"],
    ["events", "eventId"],
    ["rules", "ruleId"],
    ["sharingConditions", "conditionId"],
    ["extensionPoints", "extensionPointId"],
  ] as const)
    assertUnique(value[collection] as RecordValue[], key);
  assertUnique(value.permissions as RecordValue[], "key");
  if (value.flows !== undefined) assertUnique(value.flows as RecordValue[], "id");
  if (value.contributions !== undefined)
    assertUnique(value.contributions as RecordValue[], "contributionId");
  if (value.queries !== undefined) {
    assertUnique(value.queries as RecordValue[], "queryId");
    assertUnique(value.queries as RecordValue[], "key");
    for (const query of value.queries as RecordValue[]) {
      assertUnambiguousTypedInputs(query.inputs as RecordValue[]);
      assertUnique(query.aggregates as RecordValue[], "alias");
      assertUniqueValues(query.selectedFieldIds as unknown[]);
      assertUniqueValues(query.groupByFieldIds as unknown[]);
    }
  }
  for (const recordType of value.recordTypes as RecordValue[]) {
    assertUnique(recordType.fields as RecordValue[], "fieldId");
    assertUnique(recordType.relationships as RecordValue[], "relationshipId");
    assertUniqueValues(recordType.standardActions as unknown[]);
    assertUniqueValues(recordType.customActionIds as unknown[]);
    for (const field of recordType.fields as RecordValue[]) {
      const settings = asRecord(field.settings);
      if (field.type === "choice" || field.type === "several_choices")
        assertUnique(settings.options as RecordValue[], "value");
      if (field.type === "table") assertUnique(settings.columns as RecordValue[], "key");
      if (field.type === "formatted_text") assertUniqueValues(settings.allowedBlocks as unknown[]);
      if (field.type === "web_address" && Array.isArray(settings.allowedSchemes))
        assertUniqueValues(settings.allowedSchemes as unknown[]);
      if (field.type === "link_to_one_of_several")
        assertUniqueValues(settings.targets as unknown[]);
      if (field.type === "attachment") {
        assertUniqueValues(settings.allowedKinds as unknown[]);
        if (Array.isArray(settings.allowedExtensions))
          assertUniqueValues(settings.allowedExtensions as unknown[]);
      }
    }
  }
  for (const action of value.actions as RecordValue[])
    assertUnambiguousTypedInputs(action.inputs as RecordValue[]);
  for (const event of value.events as RecordValue[])
    assertUniqueValues(event.carriedFieldIds as unknown[]);
  for (const condition of value.sharingConditions as RecordValue[])
    assertUniqueValues(condition.declaredFieldIds as unknown[]);
  for (const point of value.extensionPoints as RecordValue[])
    assertUniqueValues(point.accepts as unknown[]);
};

/** Identity uniqueness for the definition-wide fields every Application release shares. */
export const assertUnambiguousApplicationSharedContent = (content: unknown): void => {
  const value = asRecord(content);
  for (const [collection, key] of [
    ["moduleBindings", "moduleRootId"],
    ["roles", "roleId"],
    ["queries", "queryId"],
    ["permissions", "permissionId"],
    ["pipelines", "pipelineId"],
    ["actions", "actionId"],
    ["events", "eventId"],
    ["connectionBindings", "bindingId"],
    ["interfaces", "interfaceId"],
    ["publicAddresses", "addressId"],
    ["flows", "id"],
  ] as const)
    assertUnique(value[collection] as RecordValue[], key);
  assertUnique(value.permissions as RecordValue[], "key");
  assertUnique(flattenNavigation(value.navigation as RecordValue[]), "id");
  for (const role of value.roles as RecordValue[])
    assertUniqueValues(role.permissionKeys as unknown[]);
  for (const pipeline of value.pipelines as RecordValue[])
    assertUnique(pipeline.stages as RecordValue[], "key");
  const flowBindings = value.flowBindings as RecordValue[];
  const flowBindingKeys = flowBindings.map((binding) => `${binding.controlId}:${binding.eventId}`);
  if (new Set(flowBindingKeys).size !== flowBindingKeys.length)
    refuseVersionImpact("ambiguous_component_identity");
  const flowBindingIds = flowBindings.map((binding) => binding.bindingId);
  if (new Set(flowBindingIds).size !== flowBindingIds.length)
    refuseVersionImpact("ambiguous_component_identity");
  for (const binding of value.connectionBindings as RecordValue[])
    assertUniqueValues(binding.requiredOperationKeys as unknown[]);
  for (const definition of value.interfaces as RecordValue[]) {
    assertUnique(definition.operations as RecordValue[], "operationId");
    for (const operation of definition.operations as RecordValue[])
      assertUniqueValues(operation.errorCodes as unknown[]);
  }
  for (const event of value.events as RecordValue[])
    assertUniqueValues(event.carriedFieldIds as unknown[]);
  for (const action of value.actions as RecordValue[])
    assertUnambiguousTypedInputs(action.inputs as RecordValue[]);
};
