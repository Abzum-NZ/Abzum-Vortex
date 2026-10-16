import type { canonicalValueWalker } from "./context";
import { type PreparedValidationContext, allValidationOutputs, type JsonObject } from "./context";
import type {
  DefinitionRuleFailure,
  ModuleField,
  FlowDefinition,
  VersionRequirement,
} from "../../schema";
import { object, array, outputKey, failure } from "./helpers";
import { walkPageComposition, walkPlacementData } from "../../pages/placement-walk";
import { placementSettings } from "../application-composition-catalogue";

/** One placed item as validation reads it: its props, its Vortex metadata and its settings. */
export type PlacementEntry = Readonly<{
  props: JsonObject;
  vortex: JsonObject;
  settings: JsonObject;
}>;
import { fingerprintCanonicalValue, compareCanonicalStrings } from "../canonical-json-definition";
import { applicationSearchFieldIsSelectable } from "../application-resolution";
import { type ApplicationFieldValuePair, actionValueReferenceEntry } from "./action-values";
import { permissionRecordScopesValid } from "./permission-scopes";
import { actionPermissionKeys } from "./source-paths";
import { versionRequirementAccepts } from "./publication-rules";

export function applicationScope(
  context: PreparedValidationContext,
  output: PreparedValidationContext["outputs"][number],
  failures: DefinitionRuleFailure[],
  walkValues: ReturnType<typeof canonicalValueWalker>,
) {
  const availableOutputs = allValidationOutputs(context);
  const modules = availableOutputs.filter((output) => output.kind === "module");
  const connections = availableOutputs.filter((output) => output.kind === "connection_type");
  const content = object(object(output.canonical).content);
  const bindings = array(content.moduleBindings);
  const connectionBindingEntries = array(content.connectionBindings);
  const request = context.requests.find((candidate) => candidate.source.key === outputKey(output));
  const expectedManifest = [
    ...bindings.map((binding) =>
      request?.resolution.definitions.find(
        (definition) => definition.kind === "module" && definition.rootId === binding.moduleRootId,
      ),
    ),
    ...connectionBindingEntries.map((binding) =>
      request?.resolution.definitions.find(
        (definition) =>
          definition.kind === "connection_type" && definition.rootId === binding.connectionTypeId,
      ),
    ),
  ];
  const expectedManifestFingerprints = expectedManifest
    .filter((entry) => entry !== undefined)
    .map((entry) => fingerprintCanonicalValue(entry))
    .sort(compareCanonicalStrings);
  const recordedManifestFingerprints = output.resolvedDependencies
    .map((entry) => fingerprintCanonicalValue(entry))
    .sort(compareCanonicalStrings);
  if (
    expectedManifest.some((entry) => entry === undefined) ||
    expectedManifestFingerprints.length !== recordedManifestFingerprints.length ||
    expectedManifestFingerprints.some(
      (fingerprint, index) => fingerprint !== recordedManifestFingerprints[index],
    )
  )
    failures.push(
      failure(output, "vortex.definition.application_dependency_manifest", "broken_reference"),
    );
  const boundRoots = new Set(bindings.map((binding) => String(binding.moduleRootId)));
  const boundModules = modules.filter((module) => {
    const rootId = String(object(object(module.canonical).envelope).rootId);
    const canonical = object(module.canonical);
    const envelope = object(canonical.envelope);
    const exactSnapshots = request?.resolution.definitions.filter(
      (definition) =>
        definition.kind === "module" &&
        definition.key === module.artifact.definitionKey &&
        definition.rootId === rootId &&
        definition.exactVersion === module.artifact.exactVersion,
    );
    const expected = request?.resolution.definitions.find(
      (definition) => definition.kind === "module" && definition.rootId === rootId,
    );
    return (
      boundRoots.has(rootId) &&
      exactSnapshots?.length === 1 &&
      envelope.kind === "module" &&
      expected?.key === module.artifact.definitionKey &&
      expected.exactVersion === module.artifact.exactVersion &&
      module.artifact.rootId === rootId &&
      module.artifact.resolutionFingerprint === module.resolutionFingerprint &&
      module.artifact.contentFingerprint ===
        fingerprintCanonicalValue(object(module.canonical).content)
    );
  });
  if (
    boundRoots.size !== bindings.length ||
    boundModules.length !== bindings.length ||
    new Set(
      boundModules.map(
        (module) =>
          `${module.artifact.definitionKey}\u0000${module.artifact.rootId}\u0000${module.artifact.exactVersion}`,
      ),
    ).size !== boundModules.length
  )
    failures.push(
      failure(output, "vortex.definition.application_dependency_manifest", "broken_reference"),
    );
  const recordTypes = boundModules.flatMap((module) =>
    array(object(object(module.canonical).content).recordTypes),
  );
  const records = new Map(recordTypes.map((record) => [String(record.recordTypeId), record]));
  const searchRecordOwners = new Map(
    boundModules.flatMap((module) =>
      array(object(object(module.canonical).content).recordTypes).map(
        (record) =>
          [
            String(record.recordTypeId),
            String(object(object(module.canonical).envelope).rootId),
          ] as const,
      ),
    ),
  );
  for (const entry of output.kind === "application"
    ? (output.canonical.content.search?.recordTypes ?? [])
    : []) {
    const record =
      entry.recordType.state === "resolved"
        ? records.get(String(entry.recordType.recordTypeId))
        : undefined;
    const fields = record === undefined ? [] : (array(record.fields) as unknown as ModuleField[]);
    if (
      record === undefined ||
      entry.recordType.state !== "resolved" ||
      searchRecordOwners.get(String(entry.recordType.recordTypeId)) !==
        entry.recordType.moduleRootId ||
      [
        ...entry.fields.map((field) => String(field.fieldId)),
        String(entry.titleFieldId),
        ...(entry.subtitleFieldId === undefined ? [] : [String(entry.subtitleFieldId)]),
      ].some((fieldId) => !applicationSearchFieldIsSelectable(fields, fieldId))
    )
      failures.push(
        failure(output, "vortex.definition.application_page_query", "broken_reference"),
      );
  }
  const boundRecordTypeIds = new Set(recordTypes.map((record) => String(record.recordTypeId)));
  const allFields = new Map(
    recordTypes.flatMap((record) =>
      array(record.fields).map((field) => [String(field.fieldId), field] as const),
    ),
  );
  const fieldValuePairs = new Map<string, ApplicationFieldValuePair>(
    boundModules.flatMap((module) =>
      array(object(object(module.canonical).content).recordTypes).flatMap((record) =>
        array(record.fields).map((field) => [String(field.fieldId), { field }] as const),
      ),
    ),
  );
  const relationshipMap = new Map(
    recordTypes.flatMap((record) =>
      array(record.relationships).map(
        (relationship) => [String(relationship.relationshipId), relationship] as const,
      ),
    ),
  );
  const permissionEntries = [
    ...array(content.permissions),
    ...boundModules.flatMap((module) =>
      array(object(object(module.canonical).content).permissions),
    ),
  ];
  const permissionMap = new Map(
    permissionEntries.map((permission) => [String(permission.key), permission]),
  );
  const applicationRootId = String(object(object(output.canonical).envelope).rootId);
  const permissionOwnersByKey = new Map([
    ...array(content.permissions).map(
      (permission) => [String(permission.key), `application:${applicationRootId}`] as const,
    ),
    ...boundModules.flatMap((module) =>
      array(object(object(module.canonical).content).permissions).map(
        (permission) => [String(permission.key), `module:${module.artifact.rootId}`] as const,
      ),
    ),
  ]);
  const permissions = new Set(permissionMap.keys());
  // A page discovery requirement is evaluated against the Application target. Record
  // permissions govern data operations and cannot serve as Application page gates.
  const pageNavigationPermissionKnown = (permissionKey: unknown): boolean => {
    const key = String(permissionKey);
    return (
      array(content.permissions).some(
        (permission) =>
          permission.key === key &&
          permission.actionKind === "named" &&
          permission.recordTypeId === undefined,
      ) || context.permissions.hasKey(key)
    );
  };
  // A requirement key names exactly one permission, and the runtime reads a platform catalogue
  // key as platform authority. An application or bound-Module permission reusing a platform key
  // would make that reference ambiguous, so it is refused.
  if ([...permissions].some((key) => context.permissions.hasKey(key)))
    failures.push(
      failure(output, "vortex.definition.application_identity_unique", "duplicate_key"),
    );
  const applicationPermissions = new Map(
    array(content.permissions).map((permission) => [String(permission.key), permission]),
  );
  const savedConditionEntries = boundModules.flatMap((module) =>
    array(object(object(module.canonical).content).sharingConditions),
  );
  const savedConditions = new Map(
    savedConditionEntries.map((condition) => [String(condition.conditionId), condition] as const),
  );
  if (savedConditions.size !== savedConditionEntries.length)
    failures.push(
      failure(output, "vortex.definition.application_action_references", "scope_conflict"),
    );
  if (
    !permissionRecordScopesValid(
      [...applicationPermissions.values()],
      records,
      relationshipMap,
      savedConditions,
      true,
      permissionEntries,
    )
  )
    failures.push(
      failure(output, "vortex.definition.application_action_references", "scope_conflict"),
    );
  const actions = new Map(
    [
      ...array(content.actions),
      ...boundModules.flatMap((module) => array(object(object(module.canonical).content).actions)),
    ].map((action) => [String(action.key), action]),
  );
  const publicPermissionSafe = (permissionKey: unknown) => {
    const permission = permissionMap.get(String(permissionKey));
    return permission !== undefined && permission.administrative !== true;
  };
  const publicFieldIds = (record: JsonObject | undefined) =>
    new Set(
      record
        ? array(record.fields)
            .filter((field) => field.publicDisplay === "allowed")
            .map((field) => String(field.fieldId))
        : [],
    );
  const publicActionSafe = (
    actionKey: unknown,
    expectedSubjectRecordId?: string,
    restrictedSubjectFieldIds?: ReadonlySet<string>,
    allowedRelationshipIds: ReadonlySet<string> = new Set(),
  ) => {
    const action = actions.get(String(actionKey));
    const subjectRecord = action ? records.get(String(action.subjectRecordTypeId)) : undefined;
    const subjectFieldIds = restrictedSubjectFieldIds ?? publicFieldIds(subjectRecord);
    if (
      !action ||
      action.sharing !== "allowed" ||
      !subjectRecord ||
      (expectedSubjectRecordId !== undefined &&
        String(action.subjectRecordTypeId) !== expectedSubjectRecordId) ||
      actionPermissionKeys(action).length === 0 ||
      !actionPermissionKeys(action).every(publicPermissionSafe)
    )
      return false;

    let safe = true;
    const subjectFieldIdsByKey = new Map(
      subjectRecord
        ? array(subjectRecord.fields).map(
            (field) => [String(field.key), String(field.fieldId)] as const,
          )
        : [],
    );
    const inspectSubjectReferences = (value: unknown) => {
      walkValues(value, (entry) => {
        const reference = actionValueReferenceEntry(entry);
        if (reference?.source === "trigger_record") {
          const fieldId = subjectFieldIdsByKey.get(String(reference.field));
          if (fieldId === undefined || !subjectFieldIds.has(fieldId)) safe = false;
        }
        if (entry.source === "field" && !subjectFieldIds.has(String(entry.fieldId))) safe = false;
      });
    };
    inspectSubjectReferences(action.precondition);
    for (const task of array(action.tasks)) {
      const properties = object(task.properties);
      if (String(task.type) === "record.set_fields") {
        for (const [fieldId, value] of Object.entries(object(properties.values))) {
          if (!subjectFieldIds.has(fieldId)) safe = false;
          inspectSubjectReferences(value);
        }
      }
      if (String(task.type) === "record.create") {
        const targetRecord = records.get(String(object(properties.recordType).recordTypeId));
        const targetRecordId = String(object(properties.recordType).recordTypeId);
        const targetPublicFields =
          expectedSubjectRecordId !== undefined
            ? (restrictedSubjectFieldIds ?? new Set<string>())
            : publicFieldIds(targetRecord);
        if (
          !targetRecord ||
          (expectedSubjectRecordId !== undefined && targetRecordId !== expectedSubjectRecordId) ||
          Object.keys(object(properties.values)).some((fieldId) => !targetPublicFields.has(fieldId))
        )
          safe = false;
        for (const value of Object.values(object(properties.values)))
          inspectSubjectReferences(value);
      }
      if (
        String(task.type) === "record.changes" &&
        array(properties.changes).some((change) =>
          array(change.relationshipIds).some((id) => !allowedRelationshipIds.has(String(id))),
        )
      )
        safe = false;
    }
    return safe;
  };
  const queryFieldIds = (query: JsonObject) => {
    const usedFields = new Set<string>([
      ...(query.selectedFieldIds as string[]),
      ...(query.groupByFieldIds as string[]),
      ...array(query.sort).map((sort) => String(sort.fieldId)),
      ...array(query.aggregates).flatMap((aggregate) =>
        aggregate.fieldId ? [String(aggregate.fieldId)] : [],
      ),
    ]);
    walkValues(query.filter, (entry) => {
      if (entry.source === "field") usedFields.add(String(entry.fieldId));
    });
    return usedFields;
  };
  const publicQuerySafe = (
    query: JsonObject | undefined,
    expectedRecordTypeId?: string,
    restrictedFieldIds?: ReadonlySet<string>,
  ) => {
    if (!query) return false;
    const recordTypeId = String(object(query.recordType).recordTypeId);
    if (expectedRecordTypeId !== undefined && recordTypeId !== expectedRecordTypeId) return false;
    const allowedFields = restrictedFieldIds ?? publicFieldIds(records.get(String(recordTypeId)));
    return [...queryFieldIds(query)].every((fieldId) => allowedFields.has(fieldId));
  };
  const actionKeys = new Set(actions.keys());
  const standardActionRecordTypes = new Map<string, string>(
    boundModules.flatMap((module) => {
      const canonical = object(module.canonical);
      const moduleKey = String(object(canonical.envelope).key);
      return array(object(canonical.content).recordTypes).flatMap((record) =>
        (record.standardActions as string[]).map(
          (action) =>
            [`${moduleKey}.${String(record.key)}.${action}`, String(record.recordTypeId)] as const,
        ),
      );
    }),
  );
  const standardActionKeys = new Set(standardActionRecordTypes.keys());
  const standardActionKeysByRecordAction = new Map(
    [...standardActionRecordTypes].map(
      ([key, recordTypeId]) =>
        [`${recordTypeId}:${key.slice(key.lastIndexOf(".") + 1)}`, key] as const,
    ),
  );
  const flowsForCommits = new Map(
    array(content.flows).map((flow) => [String(flow.id), flow as unknown as FlowDefinition]),
  );
  const executableActionKeys = new Set([...actionKeys, ...standardActionKeys]);
  // The record type a committed executable action belongs to: a bound Module's standard record
  // action resolves by its declared record, and a named action by its subject record.
  const commitActionRecordType = (key: string): string | undefined =>
    standardActionRecordTypes.get(key) ??
    (actions.get(key)?.subjectRecordTypeId === undefined
      ? undefined
      : String(actions.get(key)!.subjectRecordTypeId));
  const events = new Map(
    [
      ...array(content.events),
      ...boundModules.flatMap((module) => array(object(object(module.canonical).content).events)),
    ].map((event) => [String(event.key), event]),
  );
  const pages = new Map(array(content.pages).map((page) => [String(page.pageId), page]));
  const shells = new Map(array(content.shells).map((shell) => [String(shell.shellId), shell]));
  /** Every item below one item list or Puck data tree, with its settings and Vortex metadata. */
  const collectPlacementEntries = (layoutValue: unknown): [string, PlacementEntry][] => {
    const entries: [string, PlacementEntry][] = [];
    walkPlacementData(
      Array.isArray(layoutValue) ? { content: layoutValue } : layoutValue,
      ({ placementId, props, vortex }) => {
        entries.push([placementId, { props, vortex, settings: placementSettings(props) }]);
        return undefined;
      },
    );
    return entries;
  };
  const pageContentPlacementEntries = (page: JsonObject): [string, PlacementEntry][] => {
    const entries: [string, PlacementEntry][] = [];
    walkPageComposition(page.composition, ({ placementId, props, vortex }) => {
      entries.push([placementId, { props, vortex, settings: placementSettings(props) }]);
      return undefined;
    });
    return entries;
  };
  const pageShellId = (page: JsonObject): string | undefined => {
    const composition = object(page.composition);
    const data =
      composition.stepContent === undefined
        ? composition
        : object(Object.values(object(composition.stepContent))[0]);
    const shellId = object(object(object(data.root).props).vortex).shellId;
    return typeof shellId === "string" ? shellId : undefined;
  };
  const pageShellPlacementEntries = (page: JsonObject): [string, PlacementEntry][] => {
    const shellId = pageShellId(page);
    if (shellId === undefined) return [];
    return collectPlacementEntries(shells.get(shellId)?.layout);
  };
  const queries = new Map(array(content.queries).map((query) => [String(query.queryId), query]));
  // The queries a page or placement binds are the ones a bound Module exposes, by exact identity.
  const moduleQueries = new Map(
    boundModules.flatMap((module) =>
      array(object(object(module.canonical).content).queries).map(
        (query) => [String(query.queryId), query] as const,
      ),
    ),
  );
  const connectionMap = new Map(
    connections
      .filter((connection) => {
        const canonical = object(connection.canonical);
        const expected = request?.resolution.definitions.find(
          (definition) =>
            definition.kind === "connection_type" &&
            definition.rootId === canonical.connectionTypeId,
        );
        return (
          expected?.key === connection.artifact.definitionKey &&
          expected.exactVersion === connection.artifact.exactVersion &&
          connection.artifact.rootId === canonical.connectionTypeId &&
          connection.artifact.resolutionFingerprint === connection.resolutionFingerprint &&
          connection.artifact.contentFingerprint === fingerprintCanonicalValue(canonical)
        );
      })
      .map((connection) => [
        String(object(connection.canonical).connectionTypeId),
        object(connection.canonical),
      ]),
  );
  if (
    boundRoots.size !== bindings.length ||
    bindings.some((binding) => {
      const available = request?.resolution.definitions.find(
        (definition) => definition.kind === "module" && definition.rootId === binding.moduleRootId,
      );
      const dependency = modules.find(
        (module) =>
          module.artifact.kind === "module" &&
          module.artifact.rootId === binding.moduleRootId &&
          module.artifact.definitionKey === available?.key &&
          module.artifact.exactVersion === binding.resolvedVersion &&
          module.artifact.resolutionFingerprint === module.resolutionFingerprint &&
          module.artifact.contentFingerprint ===
            fingerprintCanonicalValue(object(module.canonical).content),
      );
      return (
        !available ||
        available.exactVersion !== binding.resolvedVersion ||
        !versionRequirementAccepts(
          binding.version as VersionRequirement,
          String(binding.resolvedVersion),
        ) ||
        !dependency
      );
    })
  )
    failures.push(
      failure(output, "vortex.definition.application_module_bindings", "broken_reference"),
    );
  const applicationFieldReferencesValid = (
    value: unknown,
    fields: ReadonlySet<string>,
  ): boolean => {
    let valid = true;
    walkValues(value, (entry) => {
      for (const [key, candidate] of Object.entries(entry))
        if ((key === "fieldId" || key.endsWith("FieldId")) && !fields.has(String(candidate)))
          valid = false;
    });
    return valid;
  };
  return {
    content,
    connectionBindingEntries,
    request,
    recordTypes,
    records,
    boundRecordTypeIds,
    allFields,
    fieldValuePairs,
    permissionEntries,
    permissionMap,
    permissionOwnersByKey,
    permissions,
    pageNavigationPermissionKnown,
    applicationPermissions,
    actions,
    publicPermissionSafe,
    publicActionSafe,
    queryFieldIds,
    publicQuerySafe,
    standardActionKeysByRecordAction,
    flowsForCommits,
    executableActionKeys,
    commitActionRecordType,
    events,
    pages,
    shells,
    collectPlacementEntries,
    pageContentPlacementEntries,
    pageShellPlacementEntries,
    queries,
    moduleQueries,
    connectionMap,
    applicationFieldReferencesValid,
    output,
    failures,
    walkValues,
  };
}

export type ApplicationScope = ReturnType<typeof applicationScope>;
