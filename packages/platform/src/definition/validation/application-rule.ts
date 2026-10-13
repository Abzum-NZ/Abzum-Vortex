import { type PreparedValidationContext, canonicalValueWalker, type JsonObject } from "./context";
import {
  type DefinitionRuleFailure,
  inspectApplicationPageReplacements,
  type VersionRequirement,
  type FlowDefinition,
} from "../../schema";
import { array, failure, object } from "./helpers";
import { semanticFieldType } from "./field-types";
import {
  actionPermissionKeys,
  actionPermissionsMatch,
  actionDeleteEffectsSupported,
} from "./source-paths";
import {
  applicationConditionTypesValid,
  applicationActionValueCompatible,
  actionValueReferenceEntry,
  actionFieldByKey,
  applicationFieldType,
} from "./action-values";
import { compareCanonicalStrings, fingerprintCanonicalValue } from "../canonical-json-definition";
import { versionRequirementAccepts } from "./publication-rules";
import { readFieldsTypeMapsValid } from "./permission-scopes";
import { deriveFormCommitActionKeys } from "../form-commit";
import { applicationScope } from "./application-scope";
import { applicationPageRules } from "./application-pages";
import { applicationInterfaceRules } from "./application-interfaces";

export function applicationRule(context: PreparedValidationContext): DefinitionRuleFailure[] {
  const walkValues = context.walkCanonicalValues ?? canonicalValueWalker(context);
  const failures: DefinitionRuleFailure[] = [];
  for (const output of context.outputs.filter((entry) => entry.kind === "application")) {
    const scope = applicationScope(context, output, failures, walkValues);
    const {
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
      standardActionKeysByRecordAction,
      executableActionKeys,
      commitActionRecordType,
      events,
      pages,
      shells,
      collectPlacementEntries,
      pageContentPlacementEntries,
      queries,
      connectionMap,
      applicationFieldReferencesValid,
    } = scope;

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
        context.permissions.hasKey(key),
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
    applicationPageRules(scope);
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
    applicationInterfaceRules(scope);

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
