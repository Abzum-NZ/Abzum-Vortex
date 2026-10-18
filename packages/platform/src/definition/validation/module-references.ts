import type { DefinitionRuleFailure, FlowDefinition, ModuleField } from "../../schema";
import { fingerprintCanonicalValue, compareCanonicalStrings } from "../canonical-json-definition";
import {
  type PreparedValidationContext,
  canonicalValueWalker,
  allValidationOutputs,
  type JsonObject,
} from "./context";
import { object, array, failure, rootLocation } from "./helpers";
import { readFieldsTypeMapsValid, permissionRecordScopesValid } from "./permission-scopes";
import {
  calculationDependencyFieldIds,
  typedFieldValueType,
  numericExpressionValid,
  typedConditionTypesValid,
  exactIntegerLiteral,
  fieldValueMatches,
  fieldDeclaredResultType,
  typedSemanticFieldType,
  storedNumericSummaryResultType,
} from "./field-types";
import {
  actionPermissionKeys,
  actionPermissionsMatch,
  actionDeleteEffectsSupported,
} from "./source-paths";
import {
  actionValueCompatible,
  actionValueReferenceEntry,
  actionFieldByKey,
} from "./action-values";
import { evaluateSavedSharingCondition } from "./saved-conditions";

export function moduleReferenceRule(context: PreparedValidationContext): DefinitionRuleFailure[] {
  const walkValues = context.walkCanonicalValues ?? canonicalValueWalker(context);
  const failures: DefinitionRuleFailure[] = [];
  const moduleOutputs = context.outputs.filter((output) => output.kind === "module");
  const availableModuleOutputs = allValidationOutputs(context).filter(
    (output) => output.kind === "module",
  );
  const permissionOwnersById = new Map<string, Set<string>>();
  for (const output of availableModuleOutputs) {
    const canonical = object(output.canonical);
    const moduleRootId = String(object(canonical.envelope).rootId);
    for (const permission of array(object(canonical.content).permissions)) {
      const permissionId = String(permission.permissionId);
      const owners = permissionOwnersById.get(permissionId) ?? new Set<string>();
      owners.add(moduleRootId);
      permissionOwnersById.set(permissionId, owners);
    }
  }
  const recordIdentity = (moduleRootId: string, recordTypeId: string): string =>
    `${moduleRootId}:${recordTypeId}`;
  const records = new Map<
    string,
    { record: JsonObject; moduleRootId: string; allowedModuleRoots: ReadonlySet<string> }
  >();
  const moduleContentByRootId = new Map<string, JsonObject>();
  for (const output of availableModuleOutputs) {
    const canonical = object(output.canonical);
    const content = object(canonical.content);
    const moduleRootId = String(object(canonical.envelope).rootId);
    moduleContentByRootId.set(moduleRootId, content);
    const allowedModuleRoots = new Set([
      moduleRootId,
      ...array(content.dependencies).map((dependency) => String(dependency.moduleRootId)),
    ]);
    for (const record of array(content.recordTypes))
      records.set(recordIdentity(moduleRootId, String(record.recordTypeId)), {
        record,
        moduleRootId,
        allowedModuleRoots,
      });
  }
  const recordReference = (
    reference: unknown,
    allowedModuleRoots: ReadonlySet<string>,
  ): JsonObject | undefined => {
    const resolved = object(reference);
    if (resolved.state !== "resolved") return undefined;
    const target = records.get(
      recordIdentity(String(resolved.moduleRootId), String(resolved.recordTypeId)),
    );
    if (!target || !allowedModuleRoots.has(target.moduleRootId)) return undefined;
    return target.record;
  };
  const inheritedOwnershipValid = (moduleRootId: string, record: JsonObject): boolean => {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (currentModuleRootId: string, currentRecord: JsonObject): boolean => {
      const identity = recordIdentity(currentModuleRootId, String(currentRecord.recordTypeId));
      if (visiting.has(identity)) return false;
      if (visited.has(identity)) return true;
      if (["organization_account", "group"].includes(String(currentRecord.ownershipMode))) {
        visited.add(identity);
        return true;
      }
      if (currentRecord.ownershipMode !== "inherited") return false;
      const relationship = array(currentRecord.relationships).find(
        (candidate) =>
          String(candidate.relationshipId) === String(currentRecord.ownershipRelationshipId),
      );
      const current = records.get(identity);
      const targets = relationship?.toRecordType
        ? [relationship.toRecordType]
        : array(relationship?.toRecordTypes);
      if (
        !relationship ||
        !current ||
        String(relationship.fromRecordTypeId) !== String(currentRecord.recordTypeId) ||
        targets.length === 0
      )
        return false;
      visiting.add(identity);
      const valid = targets.every((targetReference) => {
        const target = object(targetReference);
        if (target.state !== "resolved") return false;
        const targetModuleRootId = String(target.moduleRootId);
        const targetRecord = records.get(
          recordIdentity(targetModuleRootId, String(target.recordTypeId)),
        );
        return (
          current.allowedModuleRoots.has(targetModuleRootId) &&
          targetRecord !== undefined &&
          visit(targetModuleRootId, targetRecord.record)
        );
      });
      visiting.delete(identity);
      if (valid) visited.add(identity);
      return valid;
    };
    return visit(moduleRootId, record);
  };
  const fieldReferencesValid = (value: unknown, fields: ReadonlySet<string>): boolean => {
    let valid = true;
    walkValues(value, (entry) => {
      for (const [key, candidate] of Object.entries(entry))
        if ((key === "fieldId" || key.endsWith("FieldId")) && !fields.has(String(candidate)))
          valid = false;
    });
    return valid;
  };
  /**
   * Every field of one record type that the engines must work out when a record is read. A
   * deadline-passed calculation is read-time by its expression, and any calculation that
   * depends on a read-time calculation is itself read-time. Stored values may never depend on
   * one, so publication refuses a calculation declared `stored` in this set, and a total whose
   * aggregate source or filter reads it. Content without an evaluation is classified here.
   */
  const readTimeFieldIdsFor = (recordFields: readonly JsonObject[]): ReadonlySet<string> => {
    const fieldById = new Map(recordFields.map((field) => [String(field.fieldId), field] as const));
    const classification = new Map<string, boolean>();
    const isReadTime = (fieldId: string, visiting: ReadonlySet<string>): boolean => {
      const cached = classification.get(fieldId);
      if (cached !== undefined) return cached;
      const field = fieldById.get(fieldId);
      if (!field || field.type !== "calculation" || visiting.has(fieldId)) return false;
      const settings = object(field.settings);
      const expression = object(settings.expression);
      const nextVisiting = new Set(visiting).add(fieldId);
      const readTime =
        expression.kind === "deadline_passed" ||
        settings.evaluation === "read_time" ||
        array(settings.dependencyFieldIds).some((dependency) =>
          isReadTime(String(dependency), nextVisiting),
        );
      classification.set(fieldId, readTime);
      return readTime;
    };
    const result = new Set<string>();
    for (const field of recordFields) {
      const fieldId = String(field.fieldId);
      if (isReadTime(fieldId, new Set())) result.add(fieldId);
    }
    return result;
  };
  const conditionReadsReadTime = (
    value: unknown,
    readTimeFieldIds: ReadonlySet<string>,
  ): boolean => {
    let found = false;
    walkValues(value, (entry) => {
      if (entry.source === "field" && readTimeFieldIds.has(String(entry.fieldId))) found = true;
    });
    return found;
  };

  for (const output of moduleOutputs) {
    const canonical = object(output.canonical);
    const envelope = object(canonical.envelope);
    const content = object(canonical.content);
    const moduleRootId = String(envelope.rootId);
    const boundOutputs = array(content.dependencies).flatMap((dependency) =>
      availableModuleOutputs.filter(
        (candidate) =>
          candidate.artifact.rootId === dependency.moduleRootId &&
          candidate.artifact.definitionKey === dependency.moduleKey &&
          candidate.artifact.exactVersion === dependency.resolvedVersion &&
          candidate.artifact.resolutionFingerprint === candidate.resolutionFingerprint &&
          candidate.artifact.contentFingerprint ===
            fingerprintCanonicalValue(object(candidate.canonical).content),
      ),
    );
    if (
      array(content.flows).length > 0 &&
      !readFieldsTypeMapsValid(
        array(content.flows) as unknown as FlowDefinition[],
        boundOutputs.flatMap((candidate) => array(object(candidate.canonical.content).recordTypes)),
      )
    )
      failures.push(
        failure(output, "vortex.definition.module_record_references", "broken_reference"),
      );
    const allowedModuleRoots = new Set([
      moduleRootId,
      ...array(content.dependencies).map((dependency) => String(dependency.moduleRootId)),
    ]);
    const declaredDependencies = new Set(
      array(content.dependencies).map((dependency) => fingerprintCanonicalValue(dependency)),
    );
    const choicePermissionValid = (permissionId: unknown): boolean => {
      const owners = permissionOwnersById.get(String(permissionId));
      return owners !== undefined && owners.size === 1 && allowedModuleRoots.has([...owners][0]!);
    };
    const moduleRecords = new Map(
      array(content.recordTypes).map((record) => [String(record.recordTypeId), record]),
    );
    const modulePermissions = array(content.permissions);
    const modulePermissionsByKey = new Map(
      modulePermissions.map((permission) => [String(permission.key), permission]),
    );
    const actionsById = new Map(
      array(content.actions).map((action) => [String(action.actionId), action]),
    );
    const events = new Set(array(content.events).map((event) => String(event.key)));
    const relationships = new Map(
      [...moduleRecords.values()].flatMap((record) =>
        array(record.relationships).map(
          (relationship) => [String(relationship.relationshipId), relationship] as const,
        ),
      ),
    );
    const sharingConditions = new Map(
      array(content.sharingConditions).map(
        (condition) => [String(condition.conditionId), condition] as const,
      ),
    );
    if (
      !permissionRecordScopesValid(
        modulePermissions,
        moduleRecords,
        relationships,
        sharingConditions,
        true,
        modulePermissions,
      )
    )
      failures.push(
        failure(output, "vortex.definition.module_record_references", "scope_conflict"),
      );

    if (
      [...moduleRecords.values()].some(
        (record) =>
          record.ownershipMode === "inherited" && !inheritedOwnershipValid(moduleRootId, record),
      )
    )
      failures.push(
        failure(output, "vortex.definition.module_record_references", "scope_conflict"),
      );

    for (const record of moduleRecords.values()) {
      const recordId = String(record.recordTypeId);
      const fieldMap = new Map(array(record.fields).map((field) => [String(field.fieldId), field]));
      const fields = new Set(fieldMap.keys());
      const relationships = new Set(
        array(record.relationships).map((relationship) => String(relationship.relationshipId)),
      );
      if (
        !fields.has(String(record.titleFieldId)) ||
        (record.ownershipRelationshipId &&
          !relationships.has(String(record.ownershipRelationshipId))) ||
        (record.customActionIds as string[]).some((actionId) => !actionsById.has(actionId))
      )
        failures.push(
          failure(output, "vortex.definition.module_record_references", "broken_reference"),
        );
      for (const relationship of array(record.relationships)) {
        const fromField = array(record.fields).find(
          (field) => String(field.fieldId) === String(relationship.fromFieldId),
        );
        const targets = relationship.toRecordType
          ? [relationship.toRecordType]
          : (relationship.toRecordTypes as unknown[]);
        const fieldTargets =
          fromField?.type === "link"
            ? [object(fromField.settings).target]
            : fromField?.type === "link_to_one_of_several"
              ? (object(fromField.settings).targets as unknown[])
              : [];
        const targetIds = targets
          .map((target) => String(object(target).recordTypeId))
          .sort(compareCanonicalStrings);
        const fieldTargetIds = fieldTargets
          .map((target) => String(object(target).recordTypeId))
          .sort(compareCanonicalStrings);
        if (
          String(relationship.fromRecordTypeId) !== recordId ||
          !fromField ||
          JSON.stringify(targetIds) !== JSON.stringify(fieldTargetIds) ||
          object(fromField.settings).onParentDelete !== relationship.onParentDelete ||
          targets.some((target) => !recordReference(target, allowedModuleRoots))
        )
          failures.push(
            failure(output, "vortex.definition.module_relationship_references", "broken_reference"),
          );
      }
      const readTimeFieldIds = readTimeFieldIdsFor(array(record.fields));
      for (const field of array(record.fields)) {
        const settings = object(field.settings);
        let valid = true;
        const choiceSettings = [
          ...(["choice", "several_choices"].includes(String(field.type)) ? [settings] : []),
          ...(field.type === "table"
            ? array(settings.columns)
                .filter((column) => column.type === "choice" && column.settings !== undefined)
                .map((column) => object(column.settings))
            : []),
        ];
        if (
          choiceSettings.some((choice) =>
            array(choice.options).some(
              (option) =>
                option.requiredPermissionId !== undefined &&
                !choicePermissionValid(option.requiredPermissionId),
            ),
          ) ||
          (field.type === "table" &&
            array(settings.columns).some((column) => column.settings === undefined))
        )
          valid = false;
        if (field.type === "link")
          valid = recordReference(settings.target, allowedModuleRoots) !== undefined;
        if (field.type === "link_to_one_of_several")
          valid = (settings.targets as unknown[]).every(
            (target) => recordReference(target, allowedModuleRoots) !== undefined,
          );
        if (field.type === "calculation") {
          const expression = object(settings.expression);
          const expectedDependencies = calculationDependencyFieldIds(expression);
          valid =
            (settings.dependencyFieldIds as string[]).every((fieldId) => fields.has(fieldId)) &&
            fieldReferencesValid(settings.expression, fields) &&
            JSON.stringify([...new Set(settings.dependencyFieldIds as string[])]) ===
              JSON.stringify(expectedDependencies) &&
            (["decimal_number", "money"].includes(String(settings.resultType))
              ? settings.decimalPlaces !== undefined
              : settings.decimalPlaces === undefined);
          if (settings.evaluation === "stored" && readTimeFieldIds.has(String(field.fieldId)))
            valid = false;
          if (expression.kind === "join_text")
            valid =
              valid &&
              (expression.fieldIds as string[]).every((id) =>
                ["text", "choice"].includes(typedFieldValueType(fieldMap.get(id)) ?? ""),
              );
          if (expression.kind === "numeric")
            valid =
              valid && numericExpressionValid(expression, String(settings.resultType), fieldMap);
          if (expression.kind === "condition")
            valid = valid && typedConditionTypesValid(expression.condition, fieldMap);
          if (expression.kind === "date_offset") {
            const amount = object(expression.amount);
            valid =
              valid &&
              ["date", "date_time"].includes(
                typedFieldValueType(fieldMap.get(String(expression.dateFieldId))) ?? "",
              ) &&
              typedFieldValueType(fieldMap.get(String(expression.dateFieldId))) ===
                settings.resultType &&
              ((amount.source === "literal" && exactIntegerLiteral(amount.value)) ||
                (amount.source === "field" &&
                  typedFieldValueType(fieldMap.get(String(amount.fieldId))) === "whole_number"));
          }
          if (expression.kind === "deadline_passed") {
            const statusField =
              expression.statusFieldId === undefined
                ? undefined
                : fieldMap.get(String(expression.statusFieldId));
            valid =
              valid &&
              ["date", "date_time"].includes(
                typedFieldValueType(fieldMap.get(String(expression.dueFieldId))) ?? "",
              ) &&
              (expression.statusFieldId === undefined ||
                ["text", "choice"].includes(typedFieldValueType(statusField) ?? "")) &&
              (expression.statusFieldId !== undefined ||
                array(expression.terminalStatusValues).length === 0) &&
              (statusField === undefined ||
                array(expression.terminalStatusValues).every((value) =>
                  fieldValueMatches(value, statusField, "canonical"),
                ));
          }
        }
        if (field.type === "total") {
          const aggregateRelationship = [...records.values()]
            .filter((entry) => allowedModuleRoots.has(entry.moduleRootId))
            .flatMap((entry) =>
              array(entry.record.relationships).map((relationship) => ({
                relationship,
                sourceRecord: entry.record,
              })),
            )
            .find(
              (entry) =>
                String(entry.relationship.relationshipId) === String(settings.relationshipId),
            );
          const targets = aggregateRelationship?.relationship.toRecordType
            ? [aggregateRelationship.relationship.toRecordType]
            : ((aggregateRelationship?.relationship.toRecordTypes as unknown[] | undefined) ?? []);
          const reachesCurrentRecord =
            aggregateRelationship !== undefined &&
            targets.some(
              (target) => String(object(target).recordTypeId) === String(record.recordTypeId),
            );
          const aggregateFieldMap = new Map(
            aggregateRelationship
              ? array(aggregateRelationship.sourceRecord.fields).map((candidate) => [
                  String(candidate.fieldId),
                  candidate,
                ])
              : [],
          );
          const aggregateFields = new Set(aggregateFieldMap.keys());
          const aggregateField =
            settings.fieldId === undefined
              ? undefined
              : aggregateFieldMap.get(String(settings.fieldId));
          const aggregateResultType = fieldDeclaredResultType(aggregateField);
          const filterValid =
            settings.filter === undefined ||
            (fieldReferencesValid(settings.filter, aggregateFields) &&
              typedConditionTypesValid(settings.filter, aggregateFieldMap));
          let filterFieldsFilterable = true;
          if (settings.filter !== undefined)
            walkValues(settings.filter, (operand) => {
              if (
                operand.source === "field" &&
                aggregateFieldMap.get(String(operand.fieldId))?.filterable !== true
              )
                filterFieldsFilterable = false;
            });
          if (!filterFieldsFilterable)
            failures.push({
              ruleCode: "vortex.definition.total_filter_fields",
              family: "broken_reference",
              location: {
                ...rootLocation(output),
                segments: [
                  ...rootLocation(output).segments,
                  { kind: "record_type", key: String(record.key) },
                  { kind: "field", key: String(field.key) },
                ],
              },
            });
          const currencyValid =
            settings.currency === undefined ||
            (settings.operation === "sum" && aggregateResultType === "money");
          const aggregateReadTimeFieldIds = aggregateRelationship
            ? readTimeFieldIdsFor(array(aggregateRelationship.sourceRecord.fields))
            : new Set<string>();
          const readTimeDependent =
            (settings.fieldId !== undefined &&
              aggregateReadTimeFieldIds.has(String(settings.fieldId))) ||
            (settings.filter !== undefined &&
              conditionReadsReadTime(settings.filter, aggregateReadTimeFieldIds));
          valid =
            aggregateRelationship !== undefined &&
            reachesCurrentRecord &&
            filterValid &&
            !readTimeDependent &&
            currencyValid &&
            (settings.operation === "count"
              ? settings.fieldId === undefined
              : aggregateField !== undefined) &&
            (!["sum", "average"].includes(String(settings.operation)) ||
              ["whole_number", "decimal_number", "money"].includes(
                typedFieldValueType(aggregateField) ?? "",
              ));
          const declaredResultType = String(settings.resultType);
          const resultTypeValid =
            (settings.operation === "count" && declaredResultType === "whole_number") ||
            (settings.operation === "average" &&
              declaredResultType ===
                (aggregateResultType === "money" ? "money" : "decimal_number")) ||
            (["sum", "minimum", "maximum"].includes(String(settings.operation)) &&
              declaredResultType === aggregateResultType);
          const precisionValid =
            settings.operation === "average"
              ? settings.decimalPlaces !== undefined
              : settings.decimalPlaces === undefined;
          valid = valid && resultTypeValid && precisionValid;
        }
        if (!valid) {
          // Located at the field, so the builder is shown which field to change.
          const root = rootLocation(output);
          failures.push({
            ruleCode: "vortex.definition.module_field_references",
            family: "broken_reference",
            location: {
              ...root,
              segments: [
                ...root.segments,
                { kind: "record_type", key: String(record.key) },
                { kind: "field", key: String(field.key) },
              ],
            },
          });
        }
      }
      const calculationIds = new Set(
        array(record.fields)
          .filter((field) => field.type === "calculation")
          .map((field) => String(field.fieldId)),
      );
      const calculationDependencies = new Map(
        array(record.fields)
          .filter((field) => field.type === "calculation")
          .map((field) => [
            String(field.fieldId),
            (object(field.settings).dependencyFieldIds as string[]).filter((fieldId) =>
              calculationIds.has(fieldId),
            ),
          ]),
      );
      const visitingCalculations = new Set<string>();
      const visitedCalculations = new Set<string>();
      let calculationCycle = false;
      const visitCalculation = (fieldId: string) => {
        if (visitingCalculations.has(fieldId)) {
          calculationCycle = true;
          return;
        }
        if (visitedCalculations.has(fieldId)) return;
        visitingCalculations.add(fieldId);
        for (const dependency of calculationDependencies.get(fieldId) ?? [])
          visitCalculation(dependency);
        visitingCalculations.delete(fieldId);
        visitedCalculations.add(fieldId);
      };
      [...calculationDependencies.keys()].sort(compareCanonicalStrings).forEach(visitCalculation);
      if (calculationCycle)
        failures.push(
          failure(output, "vortex.definition.module_calculation_acyclic", "dependency_cycle"),
        );
    }

    for (const action of actionsById.values()) {
      const subject = moduleRecords.get(String(action.subjectRecordTypeId));
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
      const inputKeys = new Set(inputMap.keys());
      const inputTypes = new Map(
        [...inputMap].map(([key, input]) => [key, typedSemanticFieldType(input.type) ?? ""]),
      );
      let valid =
        subject !== undefined &&
        actionPermissionKeys(action).length > 0 &&
        actionPermissionsMatch(action, modulePermissionsByKey) &&
        fieldReferencesValid(action.precondition, fields) &&
        (action.precondition === undefined ||
          typedConditionTypesValid(action.precondition, fieldMap, inputTypes));
      for (const input of array(action.inputs))
        if (
          input.type === "record_reference" &&
          (input.recordTypes as unknown[]).some(
            (reference) => !recordReference(reference, allowedModuleRoots),
          )
        )
          valid = false;
      for (const task of array(action.tasks)) {
        const properties = object(task.properties);
        if (String(task.type) === "record.set_fields") {
          for (const [id, value] of Object.entries(object(properties.values)))
            if (
              !fields.has(id) ||
              !actionValueCompatible(
                value,
                fieldMap.get(id),
                fieldMap,
                inputMap,
                String(action.subjectRecordTypeId),
              )
            )
              valid = false;
        }
        if (String(task.type) === "record.changes") {
          for (const change of array(properties.changes)) {
            if (
              (change.relationshipIds as string[]).some((id) => !relationships.has(id)) ||
              inputMap.get(String(change.targetInputKey))?.type !== "record_reference" ||
              !array(inputMap.get(String(change.targetInputKey))?.recordTypes)
                .map((reference) => String(reference.recordTypeId))
                .includes(String(action.subjectRecordTypeId))
            )
              valid = false;
          }
        }
        if (String(task.type) === "event.announce" && !events.has(String(properties.eventKey)))
          valid = false;
        if (String(task.type) === "record.create") {
          const target = recordReference(properties.recordType, allowedModuleRoots);
          const targetFields = new Map(
            target ? array(target.fields).map((field) => [String(field.fieldId), field]) : [],
          );
          if (
            !target ||
            Object.entries(object(properties.values)).some(
              ([id, value]) =>
                !targetFields.has(id) ||
                !actionValueCompatible(
                  value,
                  targetFields.get(id),
                  fieldMap,
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
            !inputKeys.has(String(reference.name)) &&
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
          failure(output, "vortex.definition.module_action_references", "broken_reference"),
        );
      if (!actionDeleteEffectsSupported(action))
        failures.push(
          failure(output, "vortex.definition.module_action_references", "unsupported_choice"),
        );
    }
    // An action that names the choice option it sets: the field must be a choice of its own
    // record type with that option, every task that sets the field must set exactly that option,
    // and no other action names the same option.
    const namedOptions = new Set<string>();
    for (const action of array(content.actions)) {
      if (action.setsChoiceFieldId === undefined) continue;
      const record = moduleRecords.get(String(action.subjectRecordTypeId));
      const field = record
        ? array(record.fields).find((candidate) => candidate.fieldId === action.setsChoiceFieldId)
        : undefined;
      const optionKey = `${String(action.setsChoiceFieldId)}:${String(action.setsChoiceOption)}`;
      // Every assignment the action makes to the field must be the declared option, so a later
      // task cannot leave the record in another stage.
      const assignments = array(action.tasks).flatMap((task) => {
        if (String(task.type) !== "record.set_fields") return [];
        const values = object(object(task.properties).values);
        return String(action.setsChoiceFieldId) in values
          ? [object(values[String(action.setsChoiceFieldId)])]
          : [];
      });
      const valid =
        field?.type === "choice" &&
        array(object(field.settings).options).some(
          (option) => option.value === action.setsChoiceOption,
        ) &&
        !namedOptions.has(optionKey) &&
        assignments.length > 0 &&
        assignments.every(
          (assigned) =>
            assigned.kind === "literal" &&
            object(assigned.literal).value === action.setsChoiceOption,
        );
      namedOptions.add(optionKey);
      if (!valid)
        failures.push(
          failure(output, "vortex.definition.module_action_references", "broken_reference", {
            kind: "action",
            key: String(action.key),
          }),
        );
    }
    for (const event of array(content.events)) {
      const record = moduleRecords.get(String(event.recordTypeId));
      const fields = new Map(
        record ? array(record.fields).map((field) => [String(field.fieldId), field]) : [],
      );
      if (
        !record ||
        (event.carriedFieldIds as string[]).some(
          (fieldId) => !fields.has(fieldId) || fields.get(fieldId)?.personalData !== "none",
        )
      )
        failures.push(
          failure(output, "vortex.definition.module_event_references", "broken_reference"),
        );
    }
    for (const point of array(content.extensionPoints)) {
      const location = { kind: "extension_point" as const, key: String(point.key) };
      if (!moduleRecords.has(String(point.recordTypeId)))
        failures.push(
          failure(
            output,
            "vortex.definition.module_extension_references",
            "broken_reference",
            location,
          ),
        );
      // The module specification permits extension points to accept only additive fields and
      // actions.
      if ((point.accepts as string[]).some((kind) => kind !== "field" && kind !== "action"))
        failures.push(
          failure(
            output,
            "vortex.definition.module_extension_capabilities",
            "unsupported_choice",
            location,
          ),
        );
    }
    const contributionIds = new Set<string>();
    for (const contribution of array(content.contributions ?? [])) {
      const targetModule = object(contribution.targetModule);
      const targetRootId = String(targetModule.moduleRootId);
      const targetContent = moduleContentByRootId.get(targetRootId);
      const location = {
        kind: "extension_point" as const,
        key: String(targetModule.moduleKey),
      };
      // A contribution must target exactly one of this module's declared dependency entries,
      // never the contributing module, and that release must declare the extension point it claims.
      if (
        targetRootId === moduleRootId ||
        !declaredDependencies.has(fingerprintCanonicalValue(targetModule)) ||
        targetContent === undefined
      ) {
        failures.push(
          failure(
            output,
            "vortex.definition.module_extension_references",
            "broken_reference",
            location,
          ),
        );
        continue;
      }
      const point = array(targetContent.extensionPoints).find(
        (candidate) =>
          String(candidate.extensionPointId) === String(contribution.targetExtensionPointId),
      );
      if (point === undefined) {
        failures.push(
          failure(
            output,
            "vortex.definition.module_extension_references",
            "broken_reference",
            location,
          ),
        );
        continue;
      }
      if (!(point.accepts as string[]).includes(String(contribution.kind)))
        failures.push(
          failure(
            output,
            "vortex.definition.module_extension_capabilities",
            "unsupported_choice",
            location,
          ),
        );
      const contributedValid =
        contribution.kind === "field"
          ? (() => {
              const record = moduleRecords.get(String(contribution.recordTypeId));
              return (
                record !== undefined &&
                array(record.fields).some(
                  (field) => String(field.fieldId) === String(contribution.fieldId),
                )
              );
            })()
          : actionsById.has(String(contribution.actionId));
      if (!contributedValid)
        failures.push(
          failure(
            output,
            "vortex.definition.module_extension_references",
            "broken_reference",
            location,
          ),
        );
      const contributionId = String(contribution.contributionId);
      if (contributionIds.has(contributionId))
        failures.push(
          failure(
            output,
            "vortex.definition.module_extension_references",
            "duplicate_key",
            location,
          ),
        );
      contributionIds.add(contributionId);
    }
    for (const condition of array(content.sharingConditions)) {
      const record = moduleRecords.get(String(condition.sourceRecordTypeId));
      const fieldMap = new Map(
        record ? array(record.fields).map((field) => [String(field.fieldId), field]) : [],
      );
      const fields = new Set(fieldMap.keys());
      const parameterTypes = new Map(
        array(condition.parameters).map((parameter) => [
          String(parameter.key),
          String(parameter.type),
        ]),
      );
      let valid =
        record !== undefined &&
        (condition.declaredFieldIds as string[]).every((fieldId) => fields.has(fieldId)) &&
        fieldReferencesValid(condition.condition, fields) &&
        typedConditionTypesValid(condition.condition, fieldMap, parameterTypes);
      try {
        for (const publicationTest of array(condition.publicationTests))
          if (
            evaluateSavedSharingCondition(
              condition,
              object(publicationTest.fieldValues),
              object(publicationTest.parameters),
              [...fieldMap.values()] as ModuleField[],
            ) !== publicationTest.expected
          )
            valid = false;
      } catch {
        valid = false;
      }
      if (!valid)
        failures.push(
          failure(output, "vortex.definition.module_sharing_condition", "broken_reference"),
        );
    }
    // Module-owned queries exist only in the current Module contract, so they always read field
    // meaning through its exact value types rather than the superseded module value model.
    for (const query of array(content.queries)) {
      const location = { kind: "query" as const, key: String(query.key) };
      const targetRecord = recordReference(query.recordType, allowedModuleRoots);
      if (!targetRecord) {
        failures.push(
          failure(
            output,
            "vortex.definition.module_query_references",
            "broken_reference",
            location,
          ),
        );
        continue;
      }
      const fieldMap = new Map(
        array(targetRecord.fields).map((field) => [String(field.fieldId), field]),
      );
      const fields = new Set(fieldMap.keys());
      const selectedFieldIds = (query.selectedFieldIds as string[]).map(String);
      const groupByFieldIds = (query.groupByFieldIds as string[]).map(String);
      const sortFieldIds = array(query.sort).map((sort) => String(sort.fieldId));
      const aggregateFieldIds = array(query.aggregates).flatMap((aggregate) =>
        aggregate.fieldId === undefined ? [] : [String(aggregate.fieldId)],
      );
      const aggregateAliases = array(query.aggregates).map((aggregate) => String(aggregate.alias));
      const selectedFieldKeys = selectedFieldIds.map((id) => String(fieldMap.get(id)?.key));
      const unique = (values: readonly string[]) => new Set(values).size === values.length;
      const summaryGroupFieldTypes = new Set([
        "text",
        "whole_number",
        "decimal_number",
        "yes_no",
        "date",
        "date_time",
        "choice",
        "reference_number",
        "email_address",
        "phone_number",
        "web_address",
        "link",
        "link_to_one_of_several",
        "link_to_person",
      ]);
      const numericAggregateFieldTypes = new Set(["whole_number", "decimal_number", "money"]);
      const extremaFieldTypes = new Set([
        "text",
        "whole_number",
        "decimal_number",
        "yes_no",
        "money",
        "date",
        "date_time",
      ]);
      const refuseSummaryField = (ruleCode: string, field: JsonObject): void => {
        const root = rootLocation(output);
        failures.push({
          ruleCode,
          family: "unsupported_choice",
          location: {
            ...root,
            segments: [...root.segments, location, { kind: "field", key: String(field.key) }],
          },
        });
      };
      for (const fieldId of groupByFieldIds) {
        const field = fieldMap.get(fieldId);
        if (field && !summaryGroupFieldTypes.has(String(field.type)))
          refuseSummaryField("vortex.definition.module_query_group_field_type", field);
      }
      for (const aggregate of array(query.aggregates)) {
        if (aggregate.fieldId === undefined) continue;
        const field = fieldMap.get(String(aggregate.fieldId));
        if (!field || aggregate.operation === "count") continue;
        const storedNumericResultType = storedNumericSummaryResultType(field);
        const fieldType = storedNumericResultType ?? String(field.type);
        if (
          field.type === "total" ||
          (field.type === "calculation" && storedNumericResultType === undefined)
        )
          refuseSummaryField("vortex.definition.module_query_derived_aggregate_source", field);
        else if (
          (aggregate.operation === "sum" || aggregate.operation === "average") &&
          !numericAggregateFieldTypes.has(fieldType)
        )
          refuseSummaryField("vortex.definition.module_query_numeric_aggregate_field_type", field);
        else if (
          (aggregate.operation === "minimum" || aggregate.operation === "maximum") &&
          !extremaFieldTypes.has(fieldType)
        )
          refuseSummaryField("vortex.definition.module_query_extrema_field_type", field);
      }
      // The published projection may include explicitly selected member fields;
      // grouped ordering still names grouping keys only. Summary output remains
      // constrained to the groups and aggregates declared separately.
      const groupingValid =
        groupByFieldIds.length === 0 || sortFieldIds.every((id) => groupByFieldIds.includes(id));
      const aggregatesValid = array(query.aggregates).every((aggregate) => {
        if (aggregate.operation === "count") return aggregate.fieldId === undefined;
        return aggregate.fieldId !== undefined && fieldMap.has(String(aggregate.fieldId));
      });
      const filterValid =
        !query.filter ||
        (fieldReferencesValid(query.filter, fields) &&
          typedConditionTypesValid(
            query.filter,
            fieldMap,
            new Map(
              array(query.inputs).map((input) => [
                String(input.key),
                typedSemanticFieldType(input.type) ?? "",
              ]),
            ),
          ));
      if (
        [...selectedFieldIds, ...groupByFieldIds, ...sortFieldIds, ...aggregateFieldIds].some(
          (id) => !fields.has(id),
        ) ||
        !unique(selectedFieldIds) ||
        !unique(groupByFieldIds) ||
        !unique(sortFieldIds) ||
        // Every returned column needs one unambiguous name in the result row.
        !unique([...selectedFieldKeys, ...aggregateAliases]) ||
        !groupingValid ||
        !aggregatesValid ||
        !filterValid
      )
        failures.push(
          failure(
            output,
            "vortex.definition.module_query_references",
            "broken_reference",
            location,
          ),
        );
    }
  }
  return failures;
}
