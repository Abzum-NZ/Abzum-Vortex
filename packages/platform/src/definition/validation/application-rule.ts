import {
  type DefinitionRuleFailure,
  type ModuleField,
  type FlowDefinition,
  type VersionRequirement,
  inspectApplicationPageReplacements,
  readRecordsTableContract,
  readRecordDetailContract,
  readBoardPlacementContract,
  boardBlockSourceIsSupported,
  calendarMappingSchema,
  calendarBlockSourceIsSupported,
  moduleQueryDefinitionSchema,
  protectedReadModelKeys,
  type FlowTask,
  flowTaskChildLists,
  flowTaskRegistry,
} from "../../schema";
import { fingerprintCanonicalValue, compareCanonicalStrings } from "../canonical-json-definition";
import { applicationSearchFieldIsSelectable } from "../application-resolution";
import { platformPermissionSource } from "../../access/platform-permissions";
import {
  FORM_CONTAINER_BLOCK_RELEASE,
  FIELD_INPUT_BLOCK_RELEASE,
  FIELD_INPUT_CONTROL_RELEASES,
} from "../application-composition-catalogue";
import { tableQueryParameterFailures } from "../table-query-parameters";
import { deriveFormCommitActionKeys } from "../form-commit";
import {
  type PreparedValidationContext,
  canonicalValueWalker,
  allValidationOutputs,
  type JsonObject,
  registeredBlockReleases,
} from "./context";
import { object, array, outputKey, failure } from "./helpers";
import {
  type ApplicationFieldValuePair,
  actionValueReferenceEntry,
  applicationConditionTypesValid,
  applicationActionValueCompatible,
  actionFieldByKey,
  applicationFieldType,
  applicationInterfaceFieldType,
} from "./action-values";
import { permissionRecordScopesValid, readFieldsTypeMapsValid } from "./permission-scopes";
import {
  actionPermissionKeys,
  actionPermissionsMatch,
  actionDeleteEffectsSupported,
} from "./source-paths";
import { versionRequirementAccepts } from "./publication-rules";
import { semanticFieldType } from "./field-types";

export function applicationRule(context: PreparedValidationContext): DefinitionRuleFailure[] {
  const walkValues = context.walkCanonicalValues ?? canonicalValueWalker(context);
  const failures: DefinitionRuleFailure[] = [];
  const availableOutputs = allValidationOutputs(context);
  const modules = availableOutputs.filter((output) => output.kind === "module");
  const connections = availableOutputs.filter((output) => output.kind === "connection_type");
  for (const output of context.outputs.filter((entry) => entry.kind === "application")) {
    const content = object(object(output.canonical).content);
    const bindings = array(content.moduleBindings);
    const connectionBindingEntries = array(content.connectionBindings);
    const request = context.requests.find(
      (candidate) => candidate.source.key === outputKey(output),
    );
    const expectedManifest = [
      ...bindings.map((binding) =>
        request?.resolution.definitions.find(
          (definition) =>
            definition.kind === "module" && definition.rootId === binding.moduleRootId,
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
        ) || platformPermissionSource().hasKey(key)
      );
    };
    // A requirement key names exactly one permission, and the runtime reads a platform catalogue
    // key as platform authority. An application or bound-Module permission reusing a platform key
    // would make that reference ambiguous, so it is refused.
    if ([...permissions].some((key) => platformPermissionSource().hasKey(key)))
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
        ...boundModules.flatMap((module) =>
          array(object(object(module.canonical).content).actions),
        ),
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
            Object.keys(object(properties.values)).some(
              (fieldId) => !targetPublicFields.has(fieldId),
            )
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
              [
                `${moduleKey}.${String(record.key)}.${action}`,
                String(record.recordTypeId),
              ] as const,
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
    const collectPlacementEntries = (
      slotValue: unknown,
      entries: [string, JsonObject][] = [],
    ): [string, JsonObject][] => {
      const slot = object(slotValue);
      for (const [placementId, placementValue] of Object.entries(object(slot.placements))) {
        const placement = object(placementValue);
        entries.push([placementId, placement]);
        for (const childSlot of Object.values(object(placement.slots)))
          collectPlacementEntries(childSlot, entries);
      }
      return entries;
    };
    const pageContentPlacementEntries = (page: JsonObject): [string, JsonObject][] => {
      const composition = object(page.composition);
      if ("main" in composition) return collectPlacementEntries(composition.main);
      if ("content" in composition)
        return Object.values(object(composition.content)).flatMap((slotValue) =>
          collectPlacementEntries(slotValue),
        );
      if (composition.shellKind === "default")
        return Object.values(object(composition.stepContent)).flatMap((slotValue) =>
          collectPlacementEntries(slotValue),
        );
      return Object.values(object(composition.stepContent)).flatMap((stepValue) =>
        Object.values(object(stepValue)).flatMap((slotValue) => collectPlacementEntries(slotValue)),
      );
    };
    const pageShellPlacementEntries = (page: JsonObject): [string, JsonObject][] => {
      const composition = object(page.composition);
      if (composition.shellKind !== "application") return [];
      return collectPlacementEntries(shells.get(String(composition.shellId))?.layout);
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
          (definition) =>
            definition.kind === "module" && definition.rootId === binding.moduleRootId,
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
    for (const action of array(content.actions)) {
      const subject = records.get(String(action.subjectRecordTypeId));
      const subjectModuleBound = boundRecordTypeIds.has(String(action.subjectRecordTypeId));
      const fieldMap = new Map(
        subject ? array(subject.fields).map((field) => [String(field.fieldId), field]) : [],
      );
      const fields = new Set(fieldMap.keys());
      const relationships = new Set(
        subject
          ? array(subject.relationships).map((relationship) => String(relationship.relationshipId))
          : [],
      );
      const inputMap = new Map(array(action.inputs).map((input) => [String(input.key), input]));
      const inputs = new Set(inputMap.keys());
      const inputTypes = new Map(
        [...inputMap].map(([key, input]) => [key, semanticFieldType(input.type) ?? ""]),
      );
      // A record action changes a record under a record-scoped permission, so a platform
      // administration permission cannot gate it: the runtime record-access decision refuses
      // platform authority for a record target. The reference is refused here rather than
      // compiled into a release that cannot enforce it.
      const usesPlatformPermission = actionPermissionKeys(action).some((key) =>
        platformPermissionSource().hasKey(key),
      );
      if (usesPlatformPermission)
        failures.push(
          failure(output, "vortex.definition.application_action_references", "unsupported_choice"),
        );
      let valid =
        subject !== undefined &&
        actionPermissionKeys(action).length > 0 &&
        permissionEntries.length === permissionMap.size &&
        (usesPlatformPermission ||
          actionPermissionsMatch(action, permissionMap, permissionOwnersByKey)) &&
        applicationFieldReferencesValid(action.precondition, fields) &&
        (action.precondition === undefined ||
          applicationConditionTypesValid(
            action.precondition,
            fieldMap,
            subjectModuleBound,
            inputTypes,
          ));
      for (const task of array(action.tasks)) {
        const properties = object(task.properties);
        if (String(task.type) === "record.set_fields") {
          for (const [id, value] of Object.entries(object(properties.values)))
            if (
              !fields.has(id) ||
              !applicationActionValueCompatible(
                value,
                fieldValuePairs.get(id),
                fieldMap,
                subjectModuleBound,
                inputMap,
                String(action.subjectRecordTypeId),
              )
            )
              valid = false;
        }
        if (String(task.type) === "record.changes") {
          for (const change of array(properties.changes))
            if (
              (change.relationshipIds as string[]).some((id) => !relationships.has(id)) ||
              inputMap.get(String(change.targetInputKey))?.type !== "record_reference" ||
              !array(inputMap.get(String(change.targetInputKey))?.recordTypes)
                .map((reference) => String(reference.recordTypeId))
                .includes(String(action.subjectRecordTypeId))
            )
              valid = false;
        }
        if (String(task.type) === "event.announce" && !events.has(String(properties.eventKey)))
          valid = false;
        if (String(task.type) === "record.create") {
          const target = records.get(String(object(properties.recordType).recordTypeId));
          const targetFields = new Map(
            target ? array(target.fields).map((field) => [String(field.fieldId), field]) : [],
          );
          if (
            !target ||
            Object.entries(object(properties.values)).some(
              ([id, value]) =>
                !targetFields.has(id) ||
                !applicationActionValueCompatible(
                  value,
                  fieldValuePairs.get(id),
                  fieldMap,
                  subjectModuleBound,
                  inputMap,
                  String(action.subjectRecordTypeId),
                ),
            )
          )
            valid = false;
        }
        walkValues(task, (entry) => {
          const reference = actionValueReferenceEntry(entry);
          if (
            reference?.source === "input" &&
            !inputs.has(String(reference.name)) &&
            String(reference.name) !== "record"
          )
            valid = false;
          if (
            reference?.source === "trigger_record" &&
            actionFieldByKey(fieldMap, String(reference.field)) === undefined
          )
            valid = false;
        });
      }
      if (!valid)
        failures.push(
          failure(output, "vortex.definition.application_action_references", "broken_reference"),
        );
      if (!actionDeleteEffectsSupported(action))
        failures.push(
          failure(output, "vortex.definition.application_action_references", "unsupported_choice"),
        );
    }
    for (const event of array(content.events)) {
      const record = records.get(String(event.recordTypeId));
      const fields = new Map(
        record ? array(record.fields).map((field) => [String(field.fieldId), field]) : [],
      );
      if (
        !record ||
        (event.carriedFieldIds as string[]).some(
          (id) => !fields.has(id) || fields.get(id)?.personalData !== "none",
        )
      )
        failures.push(
          failure(output, "vortex.definition.application_event_references", "broken_reference"),
        );
    }
    const applicationPlacementEntries = [
      ...[...shells.values()].flatMap((shell) => collectPlacementEntries(shell.layout)),
      ...[...pages.values()].flatMap(pageContentPlacementEntries),
    ];
    const applicationPlacementIds = new Set(
      applicationPlacementEntries.map(([placementId]) => placementId),
    );
    for (const issue of inspectApplicationPageReplacements(
      array(content.pages).map((page) => {
        const record = page.recordType === undefined ? undefined : object(page.recordType);
        return {
          identities: [String(page.pageId)],
          type: String(page.type),
          permission: String(page.accessPermissionKey),
          replaces:
            page.replacementOfPageId === undefined ? undefined : String(page.replacementOfPageId),
          subject:
            record === undefined
              ? undefined
              : record.state === "resolved"
                ? ([String(record.moduleRootId), String(record.recordTypeId)] as const)
                : null,
        };
      }),
    ))
      failures.push(
        failure(
          output,
          issue.kind === "identity"
            ? "vortex.definition.application_identity_unique"
            : issue.kind === "permission"
              ? "vortex.definition.application_page_permission"
              : "vortex.definition.application_page_references",
          issue.kind === "identity" ? "duplicate_key" : "broken_reference",
        ),
      );
    const identityCollections: readonly (readonly [JsonObject[], string, string])[] = [
      [array(content.pages), "pageId", "key"],
      [array(content.roles), "roleId", "key"],
      [array(content.queries), "queryId", "key"],
      [array(content.pipelines), "pipelineId", "key"],
      [array(content.permissions), "permissionId", "key"],
      [array(content.actions), "actionId", "key"],
      [array(content.events), "eventId", "key"],
      [array(content.connectionBindings), "bindingId", "key"],
      [array(content.interfaces), "interfaceId", "key"],
      [array(content.publicAddresses), "addressId", "path"],
      [array(content.flows), "id", "key"],
    ] as const;
    for (const [collection, idProperty, keyProperty] of identityCollections) {
      const ids = collection.map((entry) => String(entry[idProperty]));
      const keys = collection.map((entry) => String(entry[keyProperty]));
      if (new Set(ids).size !== ids.length || new Set(keys).size !== keys.length)
        failures.push(
          failure(output, "vortex.definition.application_identity_unique", "duplicate_key"),
        );
    }
    const flowBindingKeys = array(content.flowBindings).map(
      (binding) => `${binding.controlId}\0${binding.eventId}`,
    );
    if (new Set(flowBindingKeys).size !== flowBindingKeys.length)
      failures.push(
        failure(output, "vortex.definition.application_identity_unique", "duplicate_key"),
      );
    const flowBindingIds = array(content.flowBindings).map((binding) => String(binding.bindingId));
    if (new Set(flowBindingIds).size !== flowBindingIds.length)
      failures.push(
        failure(output, "vortex.definition.application_identity_unique", "duplicate_key"),
      );
    const navigationIds: string[] = [];
    const collectNavigationIds = (items: JsonObject[]) => {
      for (const item of items) {
        navigationIds.push(String(item.id));
        if (item.type === "heading") collectNavigationIds(array(item.children));
      }
    };
    collectNavigationIds(array(content.navigation));
    const placementIds = [...applicationPlacementIds];
    const guidedStepIds = [...pages.values()].flatMap((page) =>
      page.type === "guided_form" ? array(page.steps).map((step) => String(step.id)) : [],
    );
    if (
      new Set(navigationIds).size !== navigationIds.length ||
      new Set(placementIds).size !== placementIds.length ||
      new Set(guidedStepIds).size !== guidedStepIds.length
    )
      failures.push(
        failure(output, "vortex.definition.application_identity_unique", "duplicate_key"),
      );
    if (!pages.has(String(content.homePageId)))
      failures.push(failure(output, "vortex.definition.application_home_page", "broken_reference"));
    for (const role of array(content.roles)) {
      const rolePermissionKeys = role.permissionKeys as string[];
      const permissionSelection = object(role.permissionSelection);
      const expectedWildcardPermissions = [...applicationPermissions.values()]
        .filter((permission) => permission.administrative === false)
        .sort((left, right) => compareCanonicalStrings(String(left.key), String(right.key)));
      const expectedWildcardKeys = expectedWildcardPermissions.map((permission) =>
        String(permission.key),
      );
      const wildcardSelectionValid =
        permissionSelection.kind !== "application_wildcard" ||
        (rolePermissionKeys.length > 0 &&
          rolePermissionKeys.length === expectedWildcardKeys.length &&
          rolePermissionKeys.every((key, index) => key === expectedWildcardKeys[index]) &&
          permissionSelection.catalogueFingerprint ===
            fingerprintCanonicalValue(expectedWildcardPermissions));
      if (
        !pages.has(String(role.homePageId)) ||
        rolePermissionKeys.some((key) => !permissions.has(key)) ||
        !wildcardSelectionValid
      )
        failures.push(
          failure(output, "vortex.definition.application_role_references", "broken_reference"),
        );
    }
    walkValues(content.navigation, (item) => {
      if (
        item.type === "page" &&
        (!pages.has(String(item.pageId)) || !pageNavigationPermissionKnown(item.permissionKey))
      )
        failures.push(
          failure(
            output,
            "vortex.definition.application_navigation_references",
            "broken_reference",
          ),
        );
    });
    for (const query of queries.values()) {
      const record = object(query.recordType);
      const recordType = records.get(String(record.recordTypeId));
      const moduleBound = boundRecordTypeIds.has(String(record.recordTypeId));
      const fieldMap = new Map(
        recordType ? array(recordType.fields).map((field) => [String(field.fieldId), field]) : [],
      );
      const fields = new Set(fieldMap.keys());
      const used = [
        ...(query.selectedFieldIds as string[]),
        ...(query.groupByFieldIds as string[]),
        ...array(query.sort).map((sort) => String(sort.fieldId)),
        ...array(query.aggregates).flatMap((aggregate) =>
          aggregate.fieldId ? [String(aggregate.fieldId)] : [],
        ),
      ];
      let filterFieldsValid = true;
      walkValues(query.filter, (entry) => {
        if (entry.source === "field" && !fields.has(String(entry.fieldId)))
          filterFieldsValid = false;
      });
      const aggregatesValid = array(query.aggregates).every((aggregate) => {
        if (aggregate.operation === "count") return aggregate.fieldId === undefined;
        if (!aggregate.fieldId) return false;
        const field = allFields.get(String(aggregate.fieldId));
        if (!field) return false;
        if (aggregate.operation === "sum" || aggregate.operation === "average")
          return ["number", "whole_number", "decimal_number", "money"].includes(
            applicationFieldType(fieldValuePairs.get(String(aggregate.fieldId))) ?? "",
          );
        return !["formatted_text", "table", "attachment", "link_to_one_of_several"].includes(
          String(field.type),
        );
      });
      if (
        !recordType ||
        used.some((fieldId) => !fields.has(fieldId)) ||
        !filterFieldsValid ||
        (query.filter !== undefined &&
          !applicationConditionTypesValid(query.filter, fieldMap, moduleBound)) ||
        !aggregatesValid
      )
        failures.push(
          failure(output, "vortex.definition.application_query_references", "broken_reference"),
        );
    }
    for (const page of pages.values()) {
      const pageRecordId = page.recordType
        ? String(object(page.recordType).recordTypeId)
        : undefined;
      const pageQuery = page.queryId ? moduleQueries.get(String(page.queryId)) : undefined;
      const pageQueryRecordId = pageQuery
        ? String(object(pageQuery.recordType).recordTypeId)
        : undefined;
      if (!pageNavigationPermissionKnown(page.accessPermissionKey))
        failures.push(
          failure(output, "vortex.definition.application_page_permission", "broken_reference"),
        );
      if (
        page.queryId &&
        (!pageQuery || (pageRecordId !== undefined && pageQueryRecordId !== pageRecordId))
      )
        failures.push(
          failure(output, "vortex.definition.application_page_query", "broken_reference"),
        );
      const pageRecord = page.recordType ? records.get(pageRecordId!) : undefined;
      if (page.recordType && !pageRecord)
        failures.push(
          failure(output, "vortex.definition.application_page_references", "broken_reference"),
        );
      if (page.type === "guided_form") {
        const controls = pageContentPlacementEntries(page);
        const forms = new Set(
          controls
            .filter(
              ([, placement]) =>
                String(object(placement.block).blockId) ===
                String(FORM_CONTAINER_BLOCK_RELEASE.blockId),
            )
            .map(([id]) => id.toLowerCase()),
        );
        const flowIds = new Set(
          array(content.flowBindings)
            .filter(
              (binding) =>
                binding.event === "form_submit" &&
                forms.has(String(binding.controlId).toLowerCase()),
            )
            .map((binding) => String(object(binding.flow).flowId)),
        );
        const inputBlocks = new Set([
          String(FIELD_INPUT_BLOCK_RELEASE.blockId),
          ...Object.values(FIELD_INPUT_CONTROL_RELEASES).map((release) => String(release.blockId)),
        ]);
        const fieldKeys = new Set(
          pageRecord ? array(pageRecord.fields).map((field) => String(field.key)) : [],
        );
        const seenFields = new Set<string>();
        let inputMismatch = false;
        for (const [, placement] of controls) {
          if (!inputBlocks.has(String(object(placement.block).blockId))) continue;
          const candidate = object(placement.settings).name;
          const name = candidate === undefined ? {} : object(candidate);
          const key = name.kind === "text" ? String(name.value) : "";
          if (!fieldKeys.has(key) || seenFields.has(key)) inputMismatch = true;
          seenFields.add(key);
        }
        // The runtime completes a guided form only through exactly one form on the summary step,
        // bound to the page's single completion flow.
        const summaryStep = array(page.steps).find((step) => step.summary === true);
        const composition = object(page.composition);
        const summaryContent = summaryStep
          ? object(composition.stepContent)[String(summaryStep.id)]
          : undefined;
        const summaryPlacements = summaryStep
          ? [
              ...(composition.shellKind === "application"
                ? Object.values(object(summaryContent)).flatMap((slotValue) =>
                    collectPlacementEntries(slotValue),
                  )
                : collectPlacementEntries(summaryContent)),
              ...pageShellPlacementEntries(page),
            ]
          : [];
        const summaryForms = new Set(
          summaryPlacements
            .filter(
              ([, placement]) =>
                String(object(placement.block).blockId) ===
                String(FORM_CONTAINER_BLOCK_RELEASE.blockId),
            )
            .map(([id]) => id.toLowerCase()),
        );
        const summaryFlowIds = new Set(
          array(content.flowBindings)
            .filter(
              (binding) =>
                binding.event === "form_submit" &&
                summaryForms.has(String(binding.controlId).toLowerCase()),
            )
            .map((binding) => String(object(binding.flow).flowId)),
        );
        const summaryBindingValid =
          summaryForms.size === 1 &&
          summaryFlowIds.size === 1 &&
          flowIds.has([...summaryFlowIds][0]!);
        if (forms.size === 0 || flowIds.size !== 1 || !summaryBindingValid || inputMismatch)
          failures.push(
            failure(output, "vortex.definition.application_page_references", "broken_reference", {
              kind: "page",
              key: String(page.key),
            }),
          );
      }
      const placements = [
        ...pageContentPlacementEntries(page).map(([, placement]) => placement),
        ...pageShellPlacementEntries(page).map(([, placement]) => placement),
      ];
      // A Records table or Record detail may map only fields its bound Module query selects, and
      // may order only by fields the query can order (a grouped or aggregating query orders by its
      // grouping fields). The default sort must be the query's leading sort, the order the Query
      // engine actually applies. The Query engine refuses a request for an unselected field.
      for (const placement of placements) {
        const bound =
          placement.queryId === undefined
            ? undefined
            : moduleQueries.get(String(placement.queryId));
        const block = object(placement.block);
        const blockKey = registeredBlockReleases.get(
          `${String(block.blockId)}:${String(block.releaseVersion)}`,
        )?.key;
        if (bound === undefined) {
          if (blockKey === "platform.display.calendar" || blockKey === "platform.display.board")
            failures.push(
              failure(output, "vortex.definition.application_block_settings", "broken_reference"),
            );
          continue;
        }
        const settings = object(placement.settings) as Parameters<
          typeof readRecordsTableContract
        >[0];
        const table = readRecordsTableContract(settings);
        const detail = table === undefined ? readRecordDetailContract(settings) : undefined;
        if (blockKey === "platform.display.board") {
          const board = readBoardPlacementContract(settings);
          const boardRecordType = records.get(String(object(bound.recordType).recordTypeId));
          if (
            board === undefined ||
            boardRecordType === undefined ||
            !boardBlockSourceIsSupported(bound, array(boardRecordType.fields), board)
          )
            failures.push(
              failure(output, "vortex.definition.application_block_settings", "broken_reference"),
            );
        }
        if (blockKey === "platform.display.calendar") {
          const settingFieldId = (value: unknown): string | undefined => {
            const property = object(value);
            return property.kind === "field_reference" && typeof property.fieldId === "string"
              ? property.fieldId
              : undefined;
          };
          const settingChoice = (value: unknown): string | undefined => {
            const property = object(value);
            return property.kind === "choice" && typeof property.value === "string"
              ? property.value
              : undefined;
          };
          const mappingProperties = object(object(settings.calendar_mapping).properties);
          const mappingKind = settingChoice(mappingProperties.kind);
          const startFieldId = settingFieldId(mappingProperties.start_field);
          const endFieldId = settingFieldId(mappingProperties.end_field);
          const durationFieldId = settingFieldId(mappingProperties.duration_field);
          const durationUnit = settingChoice(mappingProperties.duration_unit);
          const mappingCandidate =
            mappingKind === "start_end" &&
            startFieldId !== undefined &&
            endFieldId !== undefined &&
            durationFieldId === undefined &&
            durationUnit === undefined
              ? { kind: mappingKind, startFieldId, endFieldId }
              : mappingKind === "start_duration" &&
                  startFieldId !== undefined &&
                  endFieldId === undefined &&
                  durationFieldId !== undefined &&
                  durationUnit !== undefined
                ? { kind: mappingKind, startFieldId, durationFieldId, durationUnit }
                : undefined;
          const mapping = calendarMappingSchema.safeParse(mappingCandidate);
          const itemTitleFieldId = settingFieldId(settings.item_title_field);
          const queryRecordType = records.get(String(object(bound.recordType).recordTypeId));
          const fieldById = new Map(
            array(queryRecordType?.fields).map((field) => [
              String(field.fieldId).toLowerCase(),
              field,
            ]),
          );
          const selectedFieldIds = new Set(
            array(bound.selectedFieldIds).map((fieldId) => String(fieldId).toLowerCase()),
          );
          let calendarMappingValid = false;
          if (mapping.success && itemTitleFieldId !== undefined && queryRecordType !== undefined) {
            const startField = fieldById.get(mapping.data.startFieldId.toLowerCase());
            const titleField = fieldById.get(itemTitleFieldId.toLowerCase());
            const dateType = startField?.type;
            const dateFields =
              mapping.data.kind === "start_end"
                ? [startField, fieldById.get(mapping.data.endFieldId.toLowerCase())]
                : [startField];
            const durationField =
              mapping.data.kind === "start_duration"
                ? fieldById.get(mapping.data.durationFieldId.toLowerCase())
                : undefined;
            const durationValid =
              mapping.data.kind !== "start_duration" ||
              ((dateType === "date_time" ||
                (dateType === "date" && mapping.data.durationUnit === "days")) &&
                durationField?.type === "whole_number");
            const mappedFieldIds = [
              mapping.data.startFieldId,
              ...(mapping.data.kind === "start_end"
                ? [mapping.data.endFieldId]
                : [mapping.data.durationFieldId]),
              itemTitleFieldId,
            ];
            calendarMappingValid =
              (dateType === "date" || dateType === "date_time") &&
              dateFields.every(
                (field) =>
                  field !== undefined && field.type === dateType && field.filterable === true,
              ) &&
              durationValid &&
              titleField !== undefined &&
              calendarBlockSourceIsSupported(bound, titleField.type) &&
              mappedFieldIds.every((fieldId) => selectedFieldIds.has(fieldId.toLowerCase()));
          }
          if (!calendarMappingValid)
            failures.push(
              failure(output, "vortex.definition.application_block_settings", "broken_reference"),
            );
        }
        if (table === undefined && detail === undefined) continue;
        if (table !== undefined) {
          const query = moduleQueryDefinitionSchema.safeParse(bound);
          const families = query.success
            ? tableQueryParameterFailures(table, query.data.inputs)
            : (["broken_reference"] as const);
          for (const family of families)
            failures.push(failure(output, "vortex.definition.application_block_settings", family));
        }
        const lower = (ids: readonly unknown[]): Set<string> =>
          new Set(ids.map((id) => String(id).toLowerCase()));
        const selected = lower(array(bound.selectedFieldIds));
        const grouped =
          array(bound.groupByFieldIds).length > 0 || array(bound.aggregates).length > 0;
        const orderable = grouped ? lower(array(bound.groupByFieldIds)) : selected;
        const mapped = (fields: readonly string[], allowed: ReadonlySet<string>): boolean =>
          fields.every((field) => allowed.has(field.toLowerCase()));
        const leading = array(bound.sort)[0];
        if (
          (table !== undefined &&
            (!mapped(
              table.columns.map((column) => column.field),
              selected,
            ) ||
              !mapped(table.sortableFields, orderable) ||
              !mapped(table.filterableFields, orderable) ||
              (table.defaultSort !== undefined &&
                (!orderable.has(table.defaultSort.field.toLowerCase()) ||
                  leading === undefined ||
                  String(leading.fieldId).toLowerCase() !== table.defaultSort.field.toLowerCase() ||
                  leading.direction !== table.defaultSort.direction)))) ||
          (detail !== undefined &&
            !mapped(
              detail.fields.map((entry) => entry.field),
              selected,
            ))
        )
          failures.push(
            failure(output, "vortex.definition.application_block_settings", "broken_reference"),
          );
      }
      // A placement reads one data source: a declared protected read model or a query, never both.
      if (
        placements.some(
          (placement) =>
            placement.readModel !== undefined &&
            (placement.queryId !== undefined ||
              !(protectedReadModelKeys as readonly string[]).includes(
                String(object(placement.readModel).key),
              )),
        )
      )
        failures.push(
          failure(output, "vortex.definition.application_block_references", "broken_reference"),
        );
      if (page.type === "public") {
        const record = page.recordType
          ? records.get(String(object(page.recordType).recordTypeId))
          : undefined;
        const publicFields = new Set(
          record
            ? array(record.fields)
                .filter((field) => field.publicDisplay === "allowed")
                .map((field) => String(field.fieldId))
            : [],
        );
        const pagePublicFields = new Set(page.publicFieldIds as string[]);
        let publicBlockReferencesSafe = true;
        for (const placement of placements) {
          if (
            (placement.viewPermissionKey !== undefined &&
              !publicPermissionSafe(placement.viewPermissionKey)) ||
            (placement.usePermissionKey && !publicPermissionSafe(placement.usePermissionKey))
          )
            publicBlockReferencesSafe = false;
          walkValues(placement.visibilityCondition, (entry) => {
            if (entry.source === "field" && !pagePublicFields.has(String(entry.fieldId)))
              publicBlockReferencesSafe = false;
          });
          const inspectPublicSetting = (setting: JsonObject) => {
            if (
              setting.kind === "field_reference" &&
              !pagePublicFields.has(String(setting.fieldId))
            )
              publicBlockReferencesSafe = false;
            if (setting.kind === "relationship_reference" || setting.kind === "record_reference")
              publicBlockReferencesSafe = false;
            if (
              setting.kind === "action_reference" &&
              (setting.actionKey !== page.publicActionKey ||
                !publicActionSafe(setting.actionKey, pageRecordId, pagePublicFields))
            )
              publicBlockReferencesSafe = false;
            if (
              setting.kind === "page_reference" &&
              pages.get(String(setting.pageId))?.type !== "public"
            )
              publicBlockReferencesSafe = false;
            if (setting.kind === "pipeline_reference") publicBlockReferencesSafe = false;
            if (setting.kind === "query_reference") {
              const query = moduleQueries.get(String(setting.queryId));
              if (!publicQuerySafe(query, pageRecordId, pagePublicFields))
                publicBlockReferencesSafe = false;
            }
          };
          walkValues(placement.settings, inspectPublicSetting);
          if (placement.readModel !== undefined) publicBlockReferencesSafe = false;
          if (placement.queryId) {
            const query = moduleQueries.get(String(placement.queryId));
            if (!publicQuerySafe(query, pageRecordId, pagePublicFields))
              publicBlockReferencesSafe = false;
          }
        }
        if (
          (page.publicFieldIds as string[]).some((id) => !publicFields.has(id)) ||
          !publicPermissionSafe(page.accessPermissionKey) ||
          (page.queryId &&
            !publicQuerySafe(
              moduleQueries.get(String(page.queryId)),
              pageRecordId,
              pagePublicFields,
            )) ||
          (page.publicActionKey &&
            !publicActionSafe(page.publicActionKey, pageRecordId, pagePublicFields)) ||
          !publicBlockReferencesSafe
        )
          failures.push(
            failure(output, "vortex.definition.application_public_surface", "unsafe_content"),
          );
      }
    }
    for (const pipeline of array(content.pipelines)) {
      const record = records.get(String(object(pipeline.recordType).recordTypeId));
      const moduleBound = boundRecordTypeIds.has(String(object(pipeline.recordType).recordTypeId));
      const stageField =
        record && array(record.fields).find((field) => field.fieldId === pipeline.stageFieldId);
      if (!stageField || stageField.type !== "choice")
        failures.push(
          failure(output, "vortex.definition.application_pipeline_stage", "broken_reference"),
        );
      const stageOptions = new Set(
        stageField?.type === "choice"
          ? array(object(stageField.settings).options).map((option) => String(option.value))
          : [],
      );
      if (array(pipeline.stages).some((stage) => !stageOptions.has(String(stage.key))))
        failures.push(
          failure(output, "vortex.definition.application_pipeline_stage", "broken_reference"),
        );
      for (const stage of array(pipeline.stages)) {
        if (
          [...(stage.entryActionKeys as string[]), ...(stage.exitActionKeys as string[])].some(
            (key) => !executableActionKeys.has(key),
          )
        )
          failures.push(
            failure(
              output,
              "vortex.definition.application_pipeline_references",
              "broken_reference",
            ),
          );
      }
      const pipelineFields = new Map(
        record ? array(record.fields).map((field) => [String(field.fieldId), field]) : [],
      );
      for (const transition of array(pipeline.transitions))
        if (
          (transition.permissionKey && !permissions.has(String(transition.permissionKey))) ||
          (transition.actionKey && !executableActionKeys.has(String(transition.actionKey))) ||
          (transition.gate !== undefined &&
            !applicationConditionTypesValid(transition.gate, pipelineFields, moduleBound))
        )
          failures.push(
            failure(
              output,
              "vortex.definition.application_pipeline_references",
              "broken_reference",
            ),
          );
      for (const target of array(pipeline.timeTargets))
        if (
          !events.has(String(target.escalationEventKey)) ||
          !record ||
          array(record.fields).find((field) => field.fieldId === target.dateTimeFieldId)?.type !==
            "date_time"
        )
          failures.push(
            failure(
              output,
              "vortex.definition.application_pipeline_references",
              "broken_reference",
            ),
          );
    }
    for (const binding of connectionBindingEntries) {
      const connection = connectionMap.get(String(binding.connectionTypeId));
      const available = request?.resolution.definitions.find(
        (definition) =>
          definition.kind === "connection_type" && definition.rootId === binding.connectionTypeId,
      );
      const resolvedOperations = new Set(
        available?.kind === "connection_type" ? available.operationKeys : [],
      );
      const canonicalOperations = new Set(
        connection ? array(connection.operations).map((operation) => String(operation.key)) : [],
      );
      const operationSetsMatch =
        resolvedOperations.size === canonicalOperations.size &&
        [...resolvedOperations].every((key) => canonicalOperations.has(key));
      if (
        !available ||
        !connection ||
        available.exactVersion !== binding.resolvedVersion ||
        !versionRequirementAccepts(
          binding.version as VersionRequirement,
          String(binding.resolvedVersion),
        ) ||
        !operationSetsMatch ||
        (binding.requiredOperationKeys as string[]).some(
          (key) => !resolvedOperations.has(key) || !canonicalOperations.has(key),
        )
      )
        failures.push(
          failure(
            output,
            "vortex.definition.application_connection_operations",
            "broken_reference",
          ),
        );
    }
    const publicPaths = array(content.publicAddresses).map((address) => String(address.path));
    if (new Set(publicPaths).size !== publicPaths.length)
      failures.push(failure(output, "vortex.definition.application_public_paths", "duplicate_key"));
    for (const address of array(content.publicAddresses))
      if (pages.get(String(address.pageId))?.type !== "public")
        failures.push(
          failure(output, "vortex.definition.application_public_paths", "broken_reference"),
        );
    const allInterfacePaths = array(content.interfaces).flatMap((definition) =>
      array(definition.operations).map((operation) => String(operation.path)),
    );
    const allInterfaceOperationKeys = array(content.interfaces).flatMap((definition) =>
      array(definition.operations).map((operation) => String(operation.key)),
    );
    // An interface read names a bound Module's query by its key; a key two bound Modules share
    // is ambiguous and resolves to no query.
    const queriesByKey = new Map<string, JsonObject | undefined>();
    for (const query of moduleQueries.values())
      queriesByKey.set(String(query.key), queriesByKey.has(String(query.key)) ? undefined : query);
    const interfaceActionInputType = (type: unknown): string | undefined => {
      const value = String(type);
      if (["decimal_number", "money", "formatted_text"].includes(value)) return value;
      if (["text", "choice"].includes(value)) return "text";
      if (["number", "whole_number"].includes(value)) return "number";
      if (value === "yes_no") return "boolean";
      if (value === "date" || value === "date_time") return value;
      if (["record_reference", "organization_account_reference"].includes(value))
        return "record_reference";
      return undefined;
    };
    if (
      new Set(allInterfacePaths).size !== allInterfacePaths.length ||
      new Set(allInterfaceOperationKeys).size !== allInterfaceOperationKeys.length
    )
      failures.push(
        failure(output, "vortex.definition.application_interface_unique", "duplicate_key"),
      );
    for (const definition of array(content.interfaces)) {
      const operationIds = array(definition.operations).map((operation) =>
        String(operation.operationId),
      );
      const operationKeys = array(definition.operations).map((operation) => String(operation.key));
      const operationPaths = array(definition.operations).map((operation) =>
        String(operation.path),
      );
      if (
        new Set(operationIds).size !== operationIds.length ||
        new Set(operationKeys).size !== operationKeys.length ||
        new Set(operationPaths).size !== operationPaths.length
      )
        failures.push(
          failure(output, "vortex.definition.application_interface_unique", "duplicate_key"),
        );
      for (const operation of array(definition.operations)) {
        const target = object(operation.target);
        // A change or background start names one application-owned interactive flow entry point.
        // The flow commits exactly one piece of work besides pure and read steps, which decides
        // the shape: a Call protected operation task naming a named action is a named-action
        // entry point, and a Run background flow task is an interface-started flow. A read names
        // a declared query.
        const targetQuery =
          target.kind === "query" ? queriesByKey.get(String(target.key)) : undefined;
        const targetFlow =
          target.kind === "flow" ? flowsForCommits.get(String(target.flowId)) : undefined;
        const targetFlowTasks: FlowTask[] = [];
        const collectTargetFlowTasks = (tasks: readonly FlowTask[]): void => {
          for (const task of tasks) {
            targetFlowTasks.push(task);
            for (const child of flowTaskChildLists(task)) collectTargetFlowTasks(child.tasks);
          }
        };
        if (targetFlow !== undefined) {
          collectTargetFlowTasks(targetFlow.tasks);
          collectTargetFlowTasks(targetFlow.errors);
          collectTargetFlowTasks(targetFlow.finally);
        }
        // Running another flow, or any task that is not a pure or read step (an unregistered one
        // included), is work the operation commits.
        const committingTasks = targetFlowTasks.filter(
          (task) =>
            task.type === "run_flow" ||
            !Object.hasOwn(flowTaskRegistry, task.type) ||
            !["pure", "read"].includes(
              flowTaskRegistry[task.type as keyof typeof flowTaskRegistry].effect,
            ),
        );
        const committingTask = committingTasks.length === 1 ? committingTasks[0] : undefined;
        const committingLiteral = (name: string): string | undefined => {
          const properties = (
            committingTask as { properties?: Record<string, JsonObject> } | undefined
          )?.properties;
          const value = properties?.[name];
          return value?.kind === "literal" && typeof object(value.literal).value === "string"
            ? String(object(value.literal).value)
            : undefined;
        };
        const calledOperationKey =
          committingTask?.type === "operation.call" ? committingLiteral("operation") : undefined;
        const targetAction =
          calledOperationKey === undefined ? undefined : actions.get(calledOperationKey);
        const startedFlowId =
          committingTask?.type === "flow.run_background" ? committingLiteral("flow") : undefined;
        const targetKind: "action" | "query" | "start" | undefined =
          target.kind === "query"
            ? "query"
            : targetFlow === undefined
              ? undefined
              : targetAction !== undefined
                ? "action"
                : startedFlowId !== undefined && flowsForCommits.has(startedFlowId)
                  ? "start"
                  : undefined;
        const targetExists =
          target.kind === "query"
            ? targetQuery !== undefined
            : targetFlow !== undefined && targetFlow.execution === "interactive";
        if (
          !targetExists ||
          (operation.permissionKey && !permissions.has(String(operation.permissionKey)))
        )
          failures.push(
            failure(
              output,
              "vortex.definition.application_interface_references",
              "broken_reference",
            ),
          );
        if (
          (operation.visibility === "public" && operation.authentication !== "public") ||
          (operation.visibility === "partner" && operation.authentication !== "partner_token") ||
          (operation.visibility === "organization_private" &&
            operation.authentication !== "organization_token")
        )
          failures.push(
            failure(output, "vortex.definition.application_interface_exposure", "unsafe_content"),
          );
        if (
          (target.kind === "query" && operation.method !== "GET") ||
          (target.kind !== "query" && operation.method === "GET")
        )
          failures.push(
            failure(output, "vortex.definition.application_interface_method", "scope_conflict"),
          );

        const inputShape = object(operation.inputShape);
        const outputShape = object(operation.outputShape);
        let shapeMatchesTarget = targetExists && targetKind !== undefined;
        if (targetKind === "action") {
          const subjectBindings = Object.values(inputShape).filter(
            (descriptor) => object(object(descriptor).targetBinding).kind === "action_subject",
          );
          const actionInputBindings = Object.values(inputShape).filter(
            (descriptor) => object(object(descriptor).targetBinding).kind === "action_input",
          );
          const declaredInputs = targetAction ? array(targetAction.inputs) : [];
          const bindingsByInputKey = new Map<string, JsonObject[]>();
          for (const descriptor of actionInputBindings) {
            const key = String(object(object(descriptor).targetBinding).key);
            bindingsByInputKey.set(key, [
              ...(bindingsByInputKey.get(key) ?? []),
              object(descriptor),
            ]);
          }
          shapeMatchesTarget =
            targetAction !== undefined &&
            Object.keys(outputShape).length === 0 &&
            subjectBindings.length === 1 &&
            object(subjectBindings[0]).type === "record_reference" &&
            object(subjectBindings[0]).required === true &&
            [...bindingsByInputKey.values()].every(
              (bindingsForInput) => bindingsForInput.length === 1,
            ) &&
            [...bindingsByInputKey.keys()].every((key) =>
              declaredInputs.some((input) => input.key === key),
            ) &&
            declaredInputs.every((input) => {
              const bindingsForInput = bindingsByInputKey.get(String(input.key));
              if (!bindingsForInput) return input.required !== true;
              const descriptor = bindingsForInput[0];
              return (
                descriptor?.required === input.required &&
                descriptor?.type === interfaceActionInputType(input.type)
              );
            });
          // The interface supplies the flow's inputs, which the flow passes to the named action by
          // name, so every bound input is a flow input of the same type and every required flow
          // input is bound.
          if (targetFlow !== undefined) {
            const flowInputs = Object.entries(targetFlow.inputs);
            shapeMatchesTarget =
              shapeMatchesTarget &&
              [...bindingsByInputKey].every(([key, bindingsForInput]) => {
                const declaration = targetFlow.inputs[key];
                return (
                  declaration !== undefined &&
                  object(bindingsForInput[0]).type === interfaceActionInputType(declaration.type)
                );
              }) &&
              flowInputs.every(
                ([key, declaration]) => !declaration.required || bindingsByInputKey.has(key),
              );
          }
        }
        if (targetKind === "query") {
          const selectedFields = new Set(
            targetQuery ? (targetQuery.selectedFieldIds as string[]) : [],
          );
          const outputBindings = Object.values(outputShape);
          const queryFieldIds = outputBindings
            .filter((descriptor) => object(object(descriptor).targetBinding).kind === "query_field")
            .map((descriptor) => String(object(object(descriptor).targetBinding).fieldId));
          const pageInformation = outputBindings
            .filter(
              (descriptor) =>
                object(object(descriptor).targetBinding).kind === "query_page_information",
            )
            .map((descriptor) => String(object(object(descriptor).targetBinding).value));
          shapeMatchesTarget =
            targetQuery !== undefined &&
            Object.keys(inputShape).length === 0 &&
            queryFieldIds.length > 0 &&
            new Set(queryFieldIds).size === queryFieldIds.length &&
            new Set(pageInformation).size === pageInformation.length &&
            queryFieldIds.every((fieldId) => {
              const descriptor = outputBindings.find(
                (candidate) =>
                  object(object(candidate).targetBinding).kind === "query_field" &&
                  object(object(candidate).targetBinding).fieldId === fieldId,
              );
              return (
                selectedFields.has(fieldId) &&
                descriptor !== undefined &&
                object(descriptor).type ===
                  applicationInterfaceFieldType(fieldValuePairs.get(fieldId))
              );
            });
        }
        if (targetKind === "start") {
          const outputs = Object.values(outputShape);
          shapeMatchesTarget =
            startedFlowId !== undefined &&
            Object.keys(targetFlow?.inputs ?? {}).length === 0 &&
            Object.keys(inputShape).length === 0 &&
            outputs.length === 1 &&
            object(object(outputs[0]).targetBinding).kind === "workflow_run_id" &&
            object(outputs[0]).type === "text" &&
            object(outputs[0]).required === true;
        }
        if (!shapeMatchesTarget)
          failures.push(
            failure(output, "vortex.definition.application_interface_shape", "scope_conflict"),
          );
        // The flow's own invocation permission is checked before any start, so an interface
        // operation must require exactly that permission and can never start the flow without it.
        if (
          targetFlow?.invocationPermissionId !== undefined &&
          String(permissionMap.get(String(operation.permissionKey))?.permissionId) !==
            String(targetFlow.invocationPermissionId)
        )
          failures.push(
            failure(output, "vortex.definition.application_interface_exposure", "unsafe_content"),
          );

        if (operation.visibility === "public") {
          if (
            !publicPermissionSafe(operation.permissionKey) ||
            (targetKind === "action" &&
              calledOperationKey !== undefined &&
              !publicActionSafe(calledOperationKey))
          )
            failures.push(
              failure(output, "vortex.definition.application_interface_exposure", "unsafe_content"),
            );
          if (
            targetKind === "query" &&
            (!publicQuerySafe(targetQuery) ||
              Object.values(outputShape).some((descriptor) => {
                const binding = object(object(descriptor).targetBinding);
                return (
                  binding.kind === "query_field" &&
                  allFields.get(String(binding.fieldId))?.publicDisplay !== "allowed"
                );
              }))
          )
            failures.push(
              failure(output, "vortex.definition.application_interface_exposure", "unsafe_content"),
            );
        }
      }
    }

    // The flow compiler judged every flow with the one flow validator (`flow-validation.ts`) before
    // it produced this content, so only what binds to them is judged here.
    const flows = array(content.flows) as unknown as FlowDefinition[];
    const flowsById = new Map(flows.map((flow) => [String(flow.id), flow]));
    if (!readFieldsTypeMapsValid(flows, recordTypes))
      failures.push(
        failure(output, "vortex.definition.application_dependency_manifest", "broken_reference"),
      );
    const eventIds = new Set(array(content.events).map((event) => String(event.eventId)));
    for (const binding of array(content.flowBindings)) {
      const bindingFailure = (ruleCode: string, family: DefinitionRuleFailure["family"]) =>
        failure(output, ruleCode, family, {
          kind: "flow_binding",
          key: String(binding.bindingId),
        });
      const flowReference = object(binding.flow);
      const flow = flowsById.get(String(flowReference.flowId));
      // A binding starts an interactive flow of this release, from a control and event it declares.
      if (
        flow === undefined ||
        flow.execution !== "interactive" ||
        !applicationPlacementIds.has(String(binding.controlId)) ||
        !eventIds.has(String(binding.eventId))
      )
        failures.push(
          bindingFailure("vortex.definition.application_flow_binding_target", "broken_reference"),
        );
      if (flow === undefined) continue;
      const inputs = object(flowReference.inputs ?? {});
      if (Object.keys(inputs).some((name) => !Object.hasOwn(flow.inputs, name)))
        failures.push(
          bindingFailure("vortex.definition.application_flow_binding_inputs", "unknown_property"),
        );
      if (
        Object.entries(flow.inputs).some(
          ([name, declaration]) => declaration.required && !Object.hasOwn(inputs, name),
        )
      )
        failures.push(
          bindingFailure("vortex.definition.application_flow_binding_inputs", "required_value"),
        );
    }

    // A form declares no commit of its own: it commits what its bound `form_submit` flows commit.
    // A form or guided-form page whose flows commit nothing, or a commit that resolves to no
    // executable action, is refused rather than published as a page that cannot save; a commit of
    // an action outside the page's record type is refused as out of the form's scope.
    const formCommits = deriveFormCommitActionKeys(
      {
        pages: array(content.pages),
        shells: array(content.shells),
        flows: array(content.flows),
        flowBindings: array(content.flowBindings),
      },
      { standardActionKeysByRecordAction, executableActionKeys },
    );
    for (const page of pages.values()) {
      if (page.type !== "form" && page.type !== "guided_form") continue;
      const recordTypeId = page.recordType
        ? String(object(page.recordType).recordTypeId)
        : undefined;
      const committed = formCommits.get(String(page.pageId)) ?? [];
      if (
        recordTypeId === undefined ||
        committed.length === 0 ||
        committed.some((key) => !executableActionKeys.has(key))
      )
        failures.push(
          failure(output, "vortex.definition.application_page_references", "broken_reference"),
        );
      else if (committed.some((key) => commitActionRecordType(key) !== recordTypeId))
        failures.push(
          failure(output, "vortex.definition.application_page_references", "scope_conflict"),
        );
    }
  }
  return failures;
}
