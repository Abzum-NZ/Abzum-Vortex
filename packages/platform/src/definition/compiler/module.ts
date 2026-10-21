import type { moduleCompilationRequestSchema } from "../../schema";
import {
  moduleDraftSchema,
  moduleCompilationOutputSchema,
  isRegisteredWritableSystemProjection,
  recordOwnershipModeSchema,
  type ModuleCompilationOutput,
  type FlowDefinition,
  type DefinitionCompilationOutput,
} from "../../schema";
import { compareCanonicalStrings, fingerprintCanonicalValue } from "../canonical-json-definition";
import { DefinitionCompilationError } from "../compilation-error";
import { compileActionFlow, platformServiceProtectedOperationReference } from "./action-flows";
import { dependencyOrder, resolvedDependencies } from "./dependencies";
import { fieldSettings, validatePersonLinkApplicationAccess } from "./field-settings";
import { compileCheckedFlowSources } from "./flow-sources";
import {
  compilePermissionFieldPolicy,
  compilePermissionRecordScope,
  inheritReadTimeEvaluation,
  moduleFieldPermissionSourceOwners,
} from "./permission-scopes";
import { provenanceFor } from "./provenance";
import type { compatibleVersion } from "./resolution";
import { exactVersion, Resolution } from "./resolution";
import {
  asObject,
  compilerRootLocation,
  fail,
  type JsonObject,
  leafPaths,
  objectFromUniqueEntries,
  TRANSFORM_RULE,
} from "./shared";
import {
  actionInput,
  actionTaskValue,
  condition,
  type ModuleValueContext,
  normaliseModuleFieldValue,
  normaliseModuleTypedValue,
} from "./values";
import { moduleDependencies } from "../module-dependencies";

function compileModule(
  source: JsonObject,
  resolution: Resolution,
  metadata: JsonObject,
  savedConditionRevisions: readonly JsonObject[],
  dependencyOutputs: readonly DefinitionCompilationOutput[],
  flows: readonly FlowDefinition[],
) {
  const body = asObject(source.body);
  const definitionKey = String(source.key);
  const root = resolution.definition(definitionKey, "module");
  const permissionOwners = moduleFieldPermissionSourceOwners(source);
  const fieldsById = new Map<string, JsonObject>();
  for (const recordType of body.record_types as JsonObject[]) {
    const qualified = `${definitionKey}:${String(recordType.key)}`;
    for (const field of recordType.fields as JsonObject[])
      fieldsById.set(resolution.field(qualified, String(field.id)), field);
  }
  for (const output of dependencyOutputs) {
    if (output.kind !== "module") continue;
    for (const recordType of output.canonical.content.recordTypes as unknown as JsonObject[])
      for (const field of recordType.fields as JsonObject[])
        fieldsById.set(String(field.fieldId), field);
  }
  const fieldFor = (qualifiedRecordType: string, alias: string): JsonObject | undefined =>
    fieldsById.get(resolution.field(qualifiedRecordType, alias));
  const valueContextFor = (
    qualifiedRecordType: string,
    parameters?: ReadonlyMap<string, string>,
  ): ModuleValueContext => ({
    field: (reference, alias) => {
      if (alias !== undefined) return fieldFor(reference, alias);
      const separator = reference.lastIndexOf(".");
      return separator > reference.lastIndexOf(":")
        ? fieldFor(reference.slice(0, separator), reference.slice(separator + 1))
        : fieldFor(qualifiedRecordType, reference);
    },
    ...(parameters ? { parameters } : {}),
    resolution,
  });
  const recordTypes = (body.record_types as JsonObject[]).map((recordType) => {
    const recordKey = String(recordType.key);
    const qualified = `${definitionKey}:${recordKey}`;
    const projection = recordType.system_projection as JsonObject | undefined;
    const refresh = projection?.refresh_while as JsonObject | undefined;
    const registeredWritableUpdate =
      projection !== undefined &&
      isRegisteredWritableSystemProjection(
        recordKey,
        String(projection.protected_view),
        definitionKey,
      );
    // A system projection remains read-only except for update on the exact registered Module,
    // record type and protected view. Create, delete, restore and every other standard update
    // still refuse at publication with the stable system-record code.
    if (
      projection !== undefined &&
      (recordType.standard_actions as string[]).some(
        (action) =>
          action === "create" ||
          (action === "update" && !registeredWritableUpdate) ||
          action === "soft_delete" ||
          action === "restore",
      )
    )
      fail(
        "vortex.definition.system_record_write_refused",
        "invalid_value",
        resolution.location("record_type", recordKey),
      );
    const valueContext = valueContextFor(qualified);
    const recordTypeId = resolution.id(definitionKey, "record_type", recordKey, "content");
    const compiledFields = (recordType.fields as JsonObject[]).map((field) => ({
      fieldId: resolution.id(definitionKey, "field", String(field.id), `record:${recordKey}`),
      key: field.key,
      label: field.label,
      ...(field.help_text ? { helpText: field.help_text } : {}),
      required: field.required,
      ...(field.default !== undefined
        ? { default: normaliseModuleFieldValue(field, field.default, valueContext, true) }
        : {}),
      unique: field.unique,
      filterable: field.filterable,
      sortable: field.sortable,
      ...(field.search_priority ? { searchPriority: field.search_priority } : {}),
      personalData: field.personal_data,
      publicDisplay: field.public_display,
      type: field.type,
      settings: fieldSettings(field, qualified, resolution, permissionOwners, valueContext),
    }));
    const fields = inheritReadTimeEvaluation(recordType.fields as JsonObject[], compiledFields);
    const relationships = (recordType.relationships as JsonObject[]).map((relationship) => ({
      relationshipId: resolution.id(
        definitionKey,
        "relationship",
        String(relationship.id),
        `record:${recordKey}`,
      ),
      key: relationship.key,
      fromRecordTypeId: recordTypeId,
      fromFieldId: resolution.field(qualified, String(relationship.from_field)),
      ...(relationship.to_record_type
        ? { toRecordType: resolution.recordType(String(relationship.to_record_type)) }
        : {
            toRecordTypes: (relationship.to_record_types as string[]).map((target) =>
              resolution.recordType(target),
            ),
          }),
      cardinality: relationship.cardinality,
      onParentDelete: relationship.on_parent_delete,
    }));
    return {
      recordTypeId,
      key: recordType.key,
      singularLabel: recordType.name,
      pluralLabel: recordType.plural_name,
      titleFieldId: resolution.field(qualified, String(recordType.title_field)),
      storageContractId: resolution.id(
        definitionKey,
        "storage_contract",
        String(recordType.storage_contract_id),
        `record:${recordKey}`,
      ),
      storageScope: recordType.storage_scope,
      ...(projection === undefined
        ? {}
        : {
            systemProjection: {
              protectedView: projection.protected_view,
              ...(refresh === undefined
                ? {}
                : {
                    refreshWhile: {
                      fieldId: resolution.field(qualified, String(refresh.field)),
                      values: refresh.values,
                      intervalMilliseconds: refresh.interval_milliseconds,
                    },
                  }),
              organizationFieldId: resolution.field(
                qualified,
                String(projection.organization_field),
              ),
              revisionFieldId: resolution.field(qualified, String(projection.revision_field)),
              filterableFieldIds: (projection.filterable_fields as string[]).map((alias) =>
                resolution.field(qualified, alias),
              ),
              sortableFieldIds: (projection.sortable_fields as string[]).map((alias) =>
                resolution.field(qualified, alias),
              ),
            },
          }),
      ownershipMode: recordOwnershipModeSchema.parse(recordType.ownership_mode),
      ...(recordType.ownership_relationship
        ? {
            ownershipRelationshipId: resolution.relationship(
              qualified,
              String(recordType.ownership_relationship),
            ),
          }
        : {}),
      fields,
      relationships,
      standardActions: recordType.standard_actions,
      customActionIds: (recordType.custom_actions as string[]).map((alias) =>
        resolution.id(definitionKey, "action", alias, "content"),
      ),
      pipelines: (recordType.pipelines as JsonObject[]).map((pipeline) => ({
        pipelineId: resolution.id(
          definitionKey,
          "pipeline",
          String(pipeline.id),
          `record:${recordKey}`,
        ),
        key: pipeline.key,
        name: pipeline.name,
        stageFieldId: resolution.field(qualified, String(pipeline.stage_field)),
        stages: pipeline.stages,
        transitions: pipeline.transitions,
      })),
    };
  });
  validatePersonLinkApplicationAccess(
    source,
    resolution,
    metadata.organizationId,
    recordTypes,
    dependencyOutputs,
  );
  const qualifiedForRecord = (recordKey: string) => `${definitionKey}:${recordKey}`;
  const actions = (body.actions as JsonObject[]).map((action) => {
    const record = qualifiedForRecord(String(action.record_type));
    const localField = (alias: string) => resolution.field(record, alias);
    const inputTypes = new Map(
      (action.inputs as JsonObject[]).map((input) => [String(input.key), String(input.type)]),
    );
    const valueContext = valueContextFor(record, inputTypes);
    return {
      actionId: resolution.id(definitionKey, "action", String(action.id), "content"),
      key: action.key,
      label: action.label,
      subjectRecordTypeId: resolution.recordType(record).recordTypeId,
      ...(action.permission_alternatives
        ? { permissionKeys: action.permission_alternatives }
        : { permissionKey: action.permission }),
      sharing: action.shareable ? "allowed" : "refused",
      ...(action.sets_choice_field
        ? {
            setsChoiceFieldId: localField(String(action.sets_choice_field)),
            setsChoiceOption: action.sets_choice_option,
          }
        : {}),
      ...(action.protected_operation
        ? {
            protectedOperation: platformServiceProtectedOperationReference(
              action.protected_operation,
            ),
          }
        : {}),
      inputs: (action.inputs as JsonObject[]).map((input) => actionInput(input, resolution, true)),
      ...(action.precondition
        ? { precondition: condition(action.precondition, localField, valueContext) }
        : {}),
      tasks: (action.tasks as JsonObject[]).map((task) => {
        const id = String(task.id);
        const properties = asObject(task.properties);
        switch (String(task.type)) {
          case "record.set_fields":
            return {
              id,
              type: "record.set_fields",
              properties: {
                values: objectFromUniqueEntries(
                  Object.entries(asObject(properties.values)).map(([key, value]) => {
                    const fieldId = localField(key);
                    return [fieldId, actionTaskValue(value, fieldsById.get(fieldId), valueContext)];
                  }),
                ),
              },
            };
          case "record.create": {
            const target = String(properties.record_type);
            return {
              id,
              type: "record.create",
              properties: {
                recordType: resolution.recordType(target),
                values: objectFromUniqueEntries(
                  Object.entries(asObject(properties.values)).map(([key, value]) => {
                    const fieldId = resolution.field(target, key);
                    return [fieldId, actionTaskValue(value, fieldsById.get(fieldId), valueContext)];
                  }),
                ),
              },
            };
          }
          case "record.changes":
            return {
              id,
              type: "record.changes",
              properties: {
                changes: (properties.changes as JsonObject[]).map((change) => ({
                  kind: "copy_relationships",
                  relationshipIds: (change.relationships as string[]).map((alias) =>
                    resolution.relationship(record, alias),
                  ),
                  targetInputKey: change.target_input,
                })),
              },
            };
          case "record.delete":
            return { id, type: "record.delete", properties: {} };
          case "event.announce":
            return {
              id,
              type: "event.announce",
              properties: { eventKey: properties.event },
            };
          default:
            return fail("vortex.definition.invalid_compilation_output", "invalid_value");
        }
      }),
    };
  });
  // Every record-task Module named action also compiles to one `transaction` flow. A
  // protected-operation action instead targets one registered platform-service operation that
  // takes the subject row's identity and expected revision automatically. Its execution is not
  // built yet, so it compiles to no flow here, and the record runtime refuses to prepare it
  // because its canonical action and system projection record type are not record-task shapes.
  const usedFlowKeys = new Set(flows.map((flow) => String(flow.key)));
  const actionFlows = (body.actions as JsonObject[]).flatMap((action, actionIndex) => {
    if (action.protected_operation !== undefined) return [];
    const recordKey = String(action.record_type);
    const subjectRecord = (body.record_types as JsonObject[]).find(
      (candidate) => String(candidate.key) === recordKey,
    );
    const subjectFieldKeyById = new Map<string, string>();
    for (const field of (subjectRecord?.fields as JsonObject[] | undefined) ?? [])
      subjectFieldKeyById.set(
        resolution.id(definitionKey, "field", String(field.id), `record:${recordKey}`),
        String(field.key),
      );
    // The flow key is the action key's last segment, kept a builder key with room for a suffix
    // that separates it from an authored flow or another action of the same name.
    const keySegment = String(action.key).slice(String(action.key).lastIndexOf(".") + 1);
    const baseKey = keySegment.slice(0, 32).replace(/_+$/, "");
    let flowKey = baseKey;
    for (let suffix = 1; usedFlowKeys.has(flowKey); suffix += 1) flowKey = `${baseKey}_${suffix}`;
    usedFlowKeys.add(flowKey);
    const canonicalAction = actions[actionIndex]! as unknown as JsonObject;
    return [
      compileActionFlow(
        action,
        canonicalAction,
        flowKey,
        definitionKey,
        subjectFieldKeyById,
        // An action with permission alternatives has no single invocation permission; a flow holds
        // exactly one, so its binding keeps checking the alternatives.
        canonicalAction.permissionKey === undefined
          ? undefined
          : (resolution.permission(
              String(canonicalAction.permissionKey),
              permissionOwners,
            ) as FlowDefinition["invocationPermissionId"]),
      ),
    ];
  });
  const events = (body.events as JsonObject[]).map((event) => {
    const record = qualifiedForRecord(String(event.record_type));
    return {
      eventId: resolution.id(definitionKey, "event", String(event.id), "content"),
      key: event.key,
      label: event.label,
      recordTypeId: resolution.recordType(record).recordTypeId,
      carriedFieldIds: (event.carries as string[])
        .map((alias) => resolution.field(record, alias))
        .sort(compareCanonicalStrings),
      personalOrSensitiveValuesAllowed: false,
    };
  });
  const sharingConditions = (body.sharing_conditions as JsonObject[]).map((saved) => {
    const record = qualifiedForRecord(String(saved.source_record_type));
    const localField = (alias: string) => resolution.field(record, alias);
    const parameterTypes = new Map(
      (saved.parameters as JsonObject[]).map((parameter) => [
        String(parameter.key),
        String(parameter.type),
      ]),
    );
    const valueContext = valueContextFor(record, parameterTypes);
    const compiledCondition = condition(saved.condition, localField, valueContext);
    const conditionId = resolution.id(
      definitionKey,
      "sharing_condition",
      String(saved.id),
      "content",
    );
    const revisionMatches = savedConditionRevisions.filter(
      (assignment) => assignment.conditionId === conditionId,
    );
    if (revisionMatches.length !== 1)
      fail("vortex.definition.saved_condition_revision_required", "unresolved_reference");
    const resolved = {
      conditionId,
      sourceRecordTypeId: resolution.recordType(record).recordTypeId,
      key: saved.key,
      publishedRevision: revisionMatches[0]!.revision,
      parameters: saved.parameters,
      condition: compiledCondition,
      declaredFieldIds: (saved.declared_fields as string[]).map(localField),
      publicationTests: (saved.publication_tests as JsonObject[]).map((test) => ({
        name: test.name,
        parameters: objectFromUniqueEntries(
          Object.entries(asObject(test.parameters)).map(([key, value]) => [
            key,
            normaliseModuleTypedValue(parameterTypes.get(key), value, valueContext),
          ]),
        ),
        fieldValues: objectFromUniqueEntries(
          Object.entries(asObject(test.field_values)).map(([key, value]) => [
            localField(key),
            normaliseModuleFieldValue(fieldFor(record, key), value, valueContext),
          ]),
        ),
        expected: test.expected,
      })),
    };
    return { ...resolved, contractFingerprint: fingerprintCanonicalValue(resolved) };
  });
  const permissions = (body.permissions as JsonObject[]).map((permission) => {
    const recordScope = compilePermissionRecordScope(
      permission,
      source,
      resolution,
      sharingConditions,
      valueContextFor(`${definitionKey}:${String(permission.record_type ?? "")}`),
    );
    const fieldPolicy = compilePermissionFieldPolicy(permission, source, resolution);
    return {
      permissionId: resolution.id(definitionKey, "permission", String(permission.id), "content"),
      key: permission.key,
      label: permission.label,
      description: permission.description,
      ...(permission.record_type
        ? {
            recordTypeId: resolution.recordType(qualifiedForRecord(String(permission.record_type)))
              .recordTypeId,
          }
        : {}),
      actionKind: permission.action_kind,
      ...(permission.named_action ? { namedAction: permission.named_action } : {}),
      administrative: permission.administrative,
      ...(recordScope === undefined ? {} : { recordScope }),
      ...(fieldPolicy === undefined ? {} : { fieldPolicy }),
    };
  });
  const queries = (body.queries as JsonObject[]).map((query) => {
    const authoredRecord = String(query.record_type);
    // A local key names this module's own record; a qualified key names a declared dependency.
    const record = authoredRecord.includes(":")
      ? authoredRecord
      : qualifiedForRecord(authoredRecord);
    const localField = (alias: string) => resolution.field(record, alias);
    const inputTypes = new Map(
      (query.inputs as JsonObject[]).map((input) => [String(input.key), String(input.type)]),
    );
    const valueContext = valueContextFor(record, inputTypes);
    return {
      queryId: resolution.id(definitionKey, "query", String(query.id), "content"),
      key: query.key,
      ...(query.label ? { label: query.label } : {}),
      ...(query.description ? { description: query.description } : {}),
      exposure: query.exposure,
      recordType: resolution.recordType(record),
      inputs: (query.inputs as JsonObject[]).map((input) => actionInput(input, resolution, true)),
      selectedFieldIds: (query.select as string[]).map(localField),
      filter: query.filter ? condition(query.filter, localField, valueContext) : null,
      groupByFieldIds: (query.group_by as string[]).map(localField),
      aggregates: (query.aggregates as JsonObject[]).map((aggregate) => ({
        operation: aggregate.operation,
        ...(aggregate.field ? { fieldId: localField(String(aggregate.field)) } : {}),
        alias: aggregate.alias,
      })),
      sort: (query.sort as JsonObject[]).map((sort) => ({
        fieldId: localField(String(sort.field)),
        direction: sort.direction,
      })),
      pageSize: query.page_size,
      relationshipHops: query.relationship_hops,
    };
  });
  const derivedDependencies = moduleDependencies(source) as unknown as JsonObject[];
  const dependencies = derivedDependencies.map((dependency) => {
    const requirement = dependency.version as Parameters<typeof compatibleVersion>[0];
    const target = resolution.definition(String(dependency.module), "module");
    return {
      dependencyKey: dependency.dependency_key,
      moduleRootId: target.rootId,
      moduleKey: target.key,
      version: requirement,
      resolvedVersion: exactVersion(resolution, String(dependency.module), "module", requirement),
    };
  });
  const dependencyByKey = new Map(
    derivedDependencies.map((dependency, index) => [
      String(dependency.dependency_key),
      dependencies[index]!,
    ]),
  );
  const contributionExtensionPointId = (moduleKey: string, key: string): string => {
    try {
      return resolution.id(moduleKey, "extension_point", key, "content");
    } catch (error) {
      if (!(error instanceof DefinitionCompilationError)) throw error;
      return fail(
        "vortex.definition.module_extension_references",
        "broken_reference",
        resolution.location("extension_point", key),
      );
    }
  };
  const contributionRecordIdentity = (record: string): string => {
    try {
      return resolution.recordType(record).recordTypeId;
    } catch (error) {
      if (!(error instanceof DefinitionCompilationError)) throw error;
      return fail(
        "vortex.definition.module_extension_references",
        "broken_reference",
        resolution.location("record_type", record),
      );
    }
  };
  const contributionFieldIdentity = (record: string, field: string): string => {
    try {
      return resolution.field(record, field);
    } catch (error) {
      if (!(error instanceof DefinitionCompilationError)) throw error;
      return fail(
        "vortex.definition.module_extension_references",
        "broken_reference",
        resolution.location("field", field),
      );
    }
  };
  const contributionActionIdentity = (alias: string): string => {
    try {
      return resolution.id(definitionKey, "action", alias, "content");
    } catch (error) {
      if (!(error instanceof DefinitionCompilationError)) throw error;
      return fail(
        "vortex.definition.module_extension_references",
        "broken_reference",
        resolution.location("action", alias),
      );
    }
  };
  const authoredContributions = (body.contributions as JsonObject[] | undefined) ?? [];
  const contributions = authoredContributions.map((contribution) => {
    const targetModule = dependencyByKey.get(String(contribution.dependency));
    if (targetModule === undefined)
      return fail(
        "vortex.definition.module_extension_references",
        "broken_reference",
        resolution.location("extension_point", String(contribution.dependency)),
      );
    const targetExtensionPointId = contributionExtensionPointId(
      String(targetModule.moduleKey),
      String(contribution.extension_point),
    );
    if (contribution.kind === "field") {
      const record = qualifiedForRecord(String(contribution.record_type));
      const recordTypeId = contributionRecordIdentity(record);
      const fieldId = contributionFieldIdentity(record, String(contribution.field));
      return {
        contributionId: fieldId,
        targetModule,
        targetExtensionPointId,
        kind: "field" as const,
        recordTypeId,
        fieldId,
      };
    }
    const actionId = contributionActionIdentity(String(contribution.contributed_action));
    return {
      contributionId: actionId,
      targetModule,
      targetExtensionPointId,
      kind: "action" as const,
      actionId,
    };
  });
  const canonical = moduleDraftSchema.parse({
    envelope: {
      kind: "module",
      rootId: root.rootId,
      organizationId: metadata.organizationId,
      key: definitionKey,
      draftRevision: metadata.draftRevision,
      ...(metadata.publishedRevision ? { publishedRevision: metadata.publishedRevision } : {}),
      createdAt: metadata.createdAt,
      createdBy: metadata.createdBy,
      updatedAt: metadata.updatedAt,
      updatedBy: metadata.updatedBy,
    },
    content: {
      name: body.name,
      description: body.description,
      ownerApplication: body.owner_application,
      dependencies,
      recordTypes,
      permissions,
      actions,
      events,
      flows: [...flows, ...actionFlows],
      sharingConditions,
      extensionPoints: (body.extension_points as JsonObject[]).map((point) => ({
        extensionPointId: resolution.id(
          definitionKey,
          "extension_point",
          String(point.id),
          "content",
        ),
        key: point.key,
        recordTypeId: resolution.recordType(qualifiedForRecord(String(point.record_type)))
          .recordTypeId,
        accepts: point.accepts,
      })),
      queries,
      ...(contributions.length > 0 ? { contributions } : {}),
    },
  });
  return canonical;
}

export const standardRecordActions = new Set([
  "create",
  "read",
  "update",
  "soft_delete",
  "restore",
  "export",
]);

export function compileParsedModuleRequest(
  request: ParsedModuleRequest,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
): ModuleCompilationOutput {
  const source = request.source as unknown as JsonObject;
  try {
    const resolution = new Resolution(request.resolution, source);
    const flowSet = compileCheckedFlowSources(source, resolution, dependencyOutputs);
    const definitionKey = request.source.key;
    const canonical = moduleDraftSchema.parse(
      compileModule(
        source,
        resolution,
        request.draftMetadata as unknown as JsonObject,
        (request.savedConditionRevisions ?? []) as unknown as JsonObject[],
        dependencyOutputs,
        flowSet.flows,
      ),
    );
    // Existing provenance owns the unchanged Module field model. The flow compiler supplies the
    // exact paths of the flows, so neither is described twice.
    const provenance = provenanceFor(
      { ...source, body: { ...request.source.body, flows: [] } },
      { ...canonical, content: { ...canonical.content, flows: [] } },
      resolution,
    );
    for (const entry of flowSet.provenance)
      provenance.push({
        ...entry,
        canonicalPath: ["content", "flows", ...entry.canonicalPath],
        ...(entry.sourcePath ? { sourcePath: ["body", "flows", ...entry.sourcePath] } : {}),
      });
    // A compiled named action's flow shares the action's permanent identity, so every canonical
    // leaf of it traces to the action declaration that produced it.
    const actionIndexById = new Map(
      (canonical.content.actions as unknown as JsonObject[]).map((action, index) => [
        String(action.actionId),
        index,
      ]),
    );
    (canonical.content.flows as unknown as JsonObject[]).forEach((flow, canonicalIndex) => {
      const actionIndex = actionIndexById.get(String(flow.id));
      if (actionIndex === undefined) return;
      for (const leaf of leafPaths(flow))
        provenance.push({
          canonicalPath: ["content", "flows", canonicalIndex, ...leaf],
          origin: "source",
          sourcePath: ["body", "actions", actionIndex, "id"],
          ruleCode: TRANSFORM_RULE,
        });
    });
    const ownDefinition = resolution.definition(definitionKey, "module");
    const output = moduleCompilationOutputSchema.safeParse({
      kind: "module",
      validationContractVersion: "3.0.0",
      canonical,
      artifact: {
        kind: "module",
        definitionKey,
        rootId: ownDefinition.rootId,
        exactVersion: ownDefinition.exactVersion,
        contentFingerprint: fingerprintCanonicalValue(canonical.content),
        resolutionFingerprint: request.resolution.fingerprint,
      },
      provenance,
      dependencyOrder: dependencyOrder(source),
      resolvedDependencies: resolvedDependencies(source, resolution),
      resolutionFingerprint: request.resolution.fingerprint,
    });
    if (!output.success) fail("vortex.definition.invalid_compilation_output", "invalid_value");
    return output.data;
  } catch (error) {
    if (error instanceof DefinitionCompilationError)
      throw error.location
        ? error
        : new DefinitionCompilationError(
            error.ruleCode,
            error.family,
            compilerRootLocation(source),
          );
    return fail("vortex.definition.invalid_compilation_output", "invalid_value");
  }
}
export type ParsedModuleRequest = ReturnType<typeof moduleCompilationRequestSchema.parse>;
