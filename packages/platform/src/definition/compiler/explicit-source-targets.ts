import type { Resolution } from "./resolution";
import { asObject, type JsonObject, leafPaths, type Path, pathKey, valueAtPath } from "./shared";
import {
  isOpaqueDataPath,
  type SourceContractPositions,
  sourceToCanonicalPath,
} from "./source-paths";
import {
  applicationRolePermissionTargets,
  applicationSearchTargets,
  conditionSourceTargets,
  isInterfaceOperationFlowTargetPath,
  permissionFieldPolicyTargets,
  permissionRecordScopeTargets,
} from "./source-target-helpers";

/**
 * The compiled `carriedFieldIds` array is sorted into canonical order, so a source `carries` position is not its
 * compiled position: find the compiled position of the field that source entry resolves to.
 */
function eventCarriedFieldTarget(
  source: JsonObject,
  canonical: unknown,
  eventIndex: number,
  carriesIndex: number,
  resolution: Resolution,
): Path {
  const arrayPath: Path = ["content", "events", eventIndex, "carriedFieldIds"];
  const event = asObject((asObject(source.body).events as unknown[])[eventIndex]);
  const recordKey = String(event.record_type);
  const record = source.kind === "module" ? `${String(source.key)}:${recordKey}` : recordKey;
  const fieldId = resolution.field(record, String((event.carries as unknown[])[carriesIndex]));
  const position = (valueAtPath(canonical, arrayPath) as unknown[]).indexOf(fieldId);
  return position >= 0 ? [...arrayPath, position] : arrayPath;
}

export function explicitSourceTargets(
  source: JsonObject,
  canonical: unknown,
  sourcePath: Path,
  positions: SourceContractPositions,
  resolution: Resolution,
): Path[] | undefined {
  // An inline Module and a used Module each compile to the Application's binding of that Module
  // release, in `modules` then `uses` order. The Module key names the whole binding; every other
  // part of an inline Module is compiled into the Module release the binding pins.
  if (
    source.kind === "application" &&
    sourcePath[0] === "body" &&
    (sourcePath[1] === "modules" || sourcePath[1] === "uses") &&
    typeof sourcePath[2] === "number"
  ) {
    const owned = (asObject(source.body).modules as unknown[]).length;
    const base: Path = [
      "content",
      "moduleBindings",
      sourcePath[1] === "modules" ? sourcePath[2] : owned + sourcePath[2],
    ];
    const namesModule =
      sourcePath.length === 4 && sourcePath[3] === (sourcePath[1] === "modules" ? "key" : "module");
    return namesModule
      ? leafPaths(valueAtPath(canonical, base), base)
      : [[...base, "moduleRootId"]];
  }
  const searchTargets = applicationSearchTargets(source, canonical, sourcePath);
  if (searchTargets !== undefined) return searchTargets;
  if (isInterfaceOperationFlowTargetPath(source, sourcePath))
    return [["content", ...sourcePath.slice(1, -1), "flowId"]];
  const fieldPolicyTargets = permissionFieldPolicyTargets(
    source,
    canonical,
    sourcePath,
    resolution,
  );
  if (fieldPolicyTargets) return fieldPolicyTargets;
  const recordScopeTargets = permissionRecordScopeTargets(
    source,
    canonical,
    sourcePath,
    resolution,
  );
  if (recordScopeTargets) return recordScopeTargets;
  const conditionTargets = conditionSourceTargets(source, sourcePath);
  if (conditionTargets) {
    if (
      source.kind === "module" &&
      sourcePath[0] === "body" &&
      sourcePath[1] === "record_types" &&
      typeof sourcePath[2] === "number" &&
      sourcePath[3] === "fields" &&
      typeof sourcePath[4] === "number" &&
      sourcePath[5] === "settings" &&
      sourcePath[6] === "expression" &&
      sourcePath[7] === "condition" &&
      sourcePath.at(-1) === "field"
    ) {
      const fieldTarget = conditionTargets.find((target) => target.at(-1) === "fieldId");
      const dependencyPath: Path = [
        "content",
        "recordTypes",
        sourcePath[2],
        "fields",
        sourcePath[4],
        "settings",
        "dependencyFieldIds",
      ];
      const dependencies = valueAtPath(canonical, dependencyPath) as unknown[];
      const dependencyIndex = fieldTarget
        ? dependencies.indexOf(valueAtPath(canonical, fieldTarget))
        : -1;
      return dependencyIndex >= 0
        ? [...conditionTargets, [...dependencyPath, dependencyIndex]]
        : conditionTargets;
    }
    return conditionTargets;
  }
  if (isOpaqueDataPath(positions, sourcePath)) return undefined;
  const roleTargets = applicationRolePermissionTargets(source, canonical, sourcePath);
  if (roleTargets) return roleTargets;
  if (
    (source.kind === "module" || source.kind === "application") &&
    sourcePath[0] === "body" &&
    (sourcePath[1] === "actions" || sourcePath[1] === "queries") &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "inputs" &&
    typeof sourcePath[4] === "number" &&
    sourcePath[5] === "record_types" &&
    typeof sourcePath[6] === "number" &&
    sourcePath.length === 7
  ) {
    const targetPath: Path = [
      "content",
      sourcePath[1],
      sourcePath[2],
      "inputs",
      sourcePath[4],
      "recordTypes",
      sourcePath[6],
    ];
    return leafPaths(valueAtPath(canonical, targetPath), targetPath);
  }
  if (
    (source.kind === "module" || source.kind === "application") &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "actions" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "tasks" &&
    typeof sourcePath[4] === "number" &&
    sourcePath[5] === "properties" &&
    sourcePath[6] === "record_type" &&
    sourcePath.length === 7
  ) {
    const targetPath: Path = [
      "content",
      "actions",
      sourcePath[2],
      "tasks",
      sourcePath[4],
      "properties",
      "recordType",
    ];
    return leafPaths(valueAtPath(canonical, targetPath), targetPath);
  }
  if (
    (source.kind === "module" || source.kind === "application") &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "actions" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "protected_operation" &&
    sourcePath.length === 4
  ) {
    const targetPath: Path = ["content", "actions", sourcePath[2], "protectedOperation"];
    return leafPaths(valueAtPath(canonical, targetPath), targetPath);
  }
  if (source.kind === "connection_type" && sourcePath[0] === "body") {
    const connectionKeys: Readonly<Record<string, string>> = {
      path: "pathTemplate",
      input: "inputShapeKey",
      output: "outputShapeKey",
      max_attempts: "maximumAttempts",
      workflow_trigger: "workflowTriggerKey",
      health_operation: "healthOperationKey",
      revocation_operation: "revocationOperationKey",
    };
    const mappedKey = connectionKeys[String(sourcePath.at(-1))];
    if (mappedKey) {
      const proposed = sourceToCanonicalPath(source, canonical, sourcePath, positions);
      proposed[proposed.length - 1] = mappedKey;
      return [proposed];
    }
  }
  if (
    source.kind === "module" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "dependencies" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "module" &&
    sourcePath.length === 4
  ) {
    const base: Path = ["content", "dependencies", sourcePath[2]];
    return ["moduleRootId", "moduleKey", "resolvedVersion"].map((key) => [...base, key]);
  }
  if (
    source.kind === "module" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "contributions" &&
    typeof sourcePath[2] === "number" &&
    typeof sourcePath[3] === "string"
  ) {
    const base: Path = ["content", "contributions", sourcePath[2]];
    if (sourcePath[3] === "dependency" && sourcePath.length === 4) {
      const targetModulePath: Path = [...base, "targetModule"];
      return leafPaths(valueAtPath(canonical, targetModulePath), targetModulePath);
    }
    if (sourcePath[3] === "extension_point" && sourcePath.length === 4)
      return [[...base, "targetExtensionPointId"]];
    if (sourcePath[3] === "contributed_action" && sourcePath.length === 4)
      return [[...base, "actionId"]];
  }
  if (
    source.kind === "application" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "pipelines" &&
    typeof sourcePath[2] === "number"
  ) {
    const pipelineBase: Path = ["content", "pipelines", sourcePath[2]];
    if (sourcePath[3] === "record_type" && sourcePath.length === 4) {
      const recordTypePath = [...pipelineBase, "recordType"];
      return leafPaths(valueAtPath(canonical, recordTypePath), recordTypePath);
    }
    if (sourcePath[3] === "stage_field" && sourcePath.length === 4)
      return [[...pipelineBase, "stageFieldId"]];
    if (
      sourcePath[3] === "stages" &&
      typeof sourcePath[4] === "number" &&
      typeof sourcePath[5] === "string" &&
      typeof sourcePath[6] === "number"
    ) {
      const targetCollection: Readonly<Record<string, string>> = {
        entry_actions: "entryActionKeys",
        exit_actions: "exitActionKeys",
      };
      const target = targetCollection[sourcePath[5]];
      if (target) return [[...pipelineBase, "stages", sourcePath[4], target, sourcePath[6]]];
    }
    if (
      sourcePath[3] === "time_targets" &&
      typeof sourcePath[4] === "number" &&
      typeof sourcePath[5] === "string"
    ) {
      const targetKey: Readonly<Record<string, string>> = {
        stage: "stageKey",
        field: "dateTimeFieldId",
        escalation_event: "escalationEventKey",
      };
      const target = targetKey[sourcePath[5]];
      if (target) return [[...pipelineBase, "timeTargets", sourcePath[4], target]];
    }
  }
  if (
    source.kind === "application" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "pages" &&
    typeof sourcePath[2] === "number"
  ) {
    const pageBase: Path = ["content", "pages", sourcePath[2]];
    if (sourcePath[3] === "permission" && sourcePath.length === 4)
      return [[...pageBase, "accessPermissionKey"]];
    if (sourcePath[3] === "record_type" && sourcePath.length === 4) {
      const recordTypePath = [...pageBase, "recordType"];
      return leafPaths(valueAtPath(canonical, recordTypePath), recordTypePath);
    }
    if (
      sourcePath[3] === "public_fields" &&
      typeof sourcePath[4] === "number" &&
      sourcePath.length === 5
    )
      return [[...pageBase, "publicFieldIds", sourcePath[4]]];
    const blockCoordinates =
      sourcePath[3] === "blocks" && typeof sourcePath[4] === "number"
        ? { canonical: [...pageBase, "blocks", sourcePath[4]] as Path, propertyIndex: 5 }
        : sourcePath[3] === "steps" &&
            typeof sourcePath[4] === "number" &&
            sourcePath[5] === "blocks" &&
            typeof sourcePath[6] === "number"
          ? {
              canonical: [...pageBase, "steps", sourcePath[4], "blocks", sourcePath[6]] as Path,
              propertyIndex: 7,
            }
          : undefined;
    if (blockCoordinates && sourcePath[blockCoordinates.propertyIndex] === "id")
      return [[...blockCoordinates.canonical, "placementId"]];
  }
  if (
    (source.kind === "application" || source.kind === "module") &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "queries" &&
    typeof sourcePath[2] === "number"
  ) {
    const base: Path = ["content", "queries", sourcePath[2]];
    if (sourcePath[3] === "record_type" && sourcePath.length === 4) {
      const recordTypePath = [...base, "recordType"];
      return leafPaths(valueAtPath(canonical, recordTypePath), recordTypePath);
    }
    if (sourcePath[3] === "select" && typeof sourcePath[4] === "number")
      return [[...base, "selectedFieldIds", sourcePath[4]]];
    if (sourcePath[3] === "group_by" && typeof sourcePath[4] === "number")
      return [[...base, "groupByFieldIds", sourcePath[4]]];
  }
  if (
    source.kind === "application" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "connection_bindings" &&
    typeof sourcePath[2] === "number"
  ) {
    const base: Path = ["content", "connectionBindings", sourcePath[2]];
    if (sourcePath[3] === "connection_type" && sourcePath.length === 4)
      return [
        [...base, "connectionTypeId"],
        [...base, "resolvedVersion"],
      ];
    if (
      sourcePath[3] === "required_operations" &&
      typeof sourcePath[4] === "number" &&
      sourcePath.length === 5
    )
      return [[...base, "requiredOperationKeys", sourcePath[4]]];
  }
  if (
    source.kind === "module" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "record_types" &&
    typeof sourcePath[2] === "number"
  ) {
    const base: Path = ["content", "recordTypes", sourcePath[2]];
    if (sourcePath.length === 4 && sourcePath[3] === "id") {
      const relationshipPath = [...base, "relationships"];
      return [
        [...base, "recordTypeId"],
        ...((valueAtPath(canonical, relationshipPath) as unknown[]) ?? []).map(
          (_relationship, index) => [...relationshipPath, index, "fromRecordTypeId"] as Path,
        ),
      ];
    }
    if (sourcePath.length === 4 && sourcePath[3] === "name") return [[...base, "singularLabel"]];
    if (sourcePath.length === 4 && sourcePath[3] === "plural_name")
      return [[...base, "pluralLabel"]];
    if (
      sourcePath[3] === "custom_actions" &&
      typeof sourcePath[4] === "number" &&
      sourcePath.length === 5
    )
      return [[...base, "customActionIds", sourcePath[4]]];
    if (
      sourcePath[3] === "relationships" &&
      typeof sourcePath[4] === "number" &&
      ((sourcePath[5] === "to_record_type" && sourcePath.length === 6) ||
        (sourcePath[5] === "to_record_types" &&
          typeof sourcePath[6] === "number" &&
          sourcePath.length === 7))
    ) {
      const relationshipTargetPath: Path = [
        ...base,
        "relationships",
        sourcePath[4],
        sourcePath[5] === "to_record_type" ? "toRecordType" : "toRecordTypes",
        ...(sourcePath[5] === "to_record_types" ? [sourcePath[6] as number] : []),
      ];
      return leafPaths(valueAtPath(canonical, relationshipTargetPath), relationshipTargetPath);
    }
    if (
      sourcePath[3] === "fields" &&
      typeof sourcePath[4] === "number" &&
      sourcePath[5] === "settings" &&
      sourcePath.length === 7 &&
      sourcePath[6] === "relationship"
    )
      return [[...base, "fields", sourcePath[4], "settings", "relationshipId"]];
    if (
      sourcePath[3] === "fields" &&
      typeof sourcePath[4] === "number" &&
      sourcePath[5] === "settings" &&
      ((sourcePath[6] === "target" && sourcePath.length === 7) ||
        (sourcePath[6] === "targets" &&
          typeof sourcePath[7] === "number" &&
          sourcePath.length === 8))
    ) {
      const targetPath: Path = [
        ...base,
        "fields",
        sourcePath[4],
        "settings",
        sourcePath[6],
        ...(sourcePath[6] === "targets" ? [sourcePath[7] as number] : []),
      ];
      return leafPaths(valueAtPath(canonical, targetPath), targetPath);
    }
    if (
      sourcePath[3] === "fields" &&
      typeof sourcePath[4] === "number" &&
      sourcePath[5] === "settings" &&
      sourcePath.length === 7 &&
      sourcePath[6] === "decimal_places"
    )
      return [[...base, "fields", sourcePath[4], "settings", "decimalPlaces"]];
    if (
      sourcePath[3] === "fields" &&
      typeof sourcePath[4] === "number" &&
      sourcePath[5] === "settings" &&
      sourcePath[6] === "expression"
    ) {
      const fieldBase: Path = [...base, "fields", sourcePath[4], "settings"];
      const expressionBase: Path = [...fieldBase, "expression"];
      if (sourcePath.length === 8 && sourcePath[7] === "operation")
        return [[...expressionBase, "kind"]];
      if (sourcePath.length === 8 && sourcePath[7] === "numeric_operation")
        return [[...expressionBase, "operation"]];
      if (
        sourcePath[7] === "fields" &&
        typeof sourcePath[8] === "number" &&
        sourcePath.length === 9
      )
        return [
          [...expressionBase, "fieldIds", sourcePath[8]],
          [...fieldBase, "dependencyFieldIds", sourcePath[8]],
        ];
      const dependencyByKey: Readonly<Record<string, number>> = {
        amount_field: 0,
        percentage_field: 1,
        date_field: 0,
        due_field: 0,
        status_field: 1,
      };
      if (sourcePath.length === 8 && typeof sourcePath[7] === "string") {
        const expressionKeyBySource: Readonly<Record<string, string>> = {
          amount_field: "amountFieldId",
          percentage_field: "percentageFieldId",
          date_field: "dateFieldId",
          due_field: "dueFieldId",
          status_field: "statusFieldId",
        };
        const expressionKey = expressionKeyBySource[sourcePath[7]];
        const dependencyIndex = dependencyByKey[sourcePath[7]];
        if (expressionKey !== undefined && dependencyIndex !== undefined)
          return [
            [...expressionBase, expressionKey],
            [...fieldBase, "dependencyFieldIds", dependencyIndex],
          ];
      }
      // A numeric operand may itself be a numeric operation over nested operands; the nesting keeps
      // its shape and only the operation and field keys are renamed.
      let leafIndex = 9;
      while (sourcePath[leafIndex] === "operands" && typeof sourcePath[leafIndex + 1] === "number")
        leafIndex += 2;
      const leaf = sourcePath[leafIndex];
      if (
        sourcePath[7] === "operands" &&
        typeof sourcePath[8] === "number" &&
        typeof leaf === "string"
      ) {
        const operandBase: Path = [...expressionBase, ...sourcePath.slice(7, leafIndex)];
        if (leaf === "numeric_operation") return [[...operandBase, "operation"]];
        if (leaf === "field") {
          const expression = asObject(
            valueAtPath(source, [
              "body",
              "record_types",
              sourcePath[2],
              "fields",
              sourcePath[4],
              "settings",
              "expression",
            ]),
          );
          // Field dependencies are collected depth first, in operand order, as the compiler does.
          const fieldOperandPaths: string[] = [];
          const collect = (operands: JsonObject[], prefix: Path) =>
            operands.forEach((operand, index) => {
              if (operand.source === "field") fieldOperandPaths.push(pathKey([...prefix, index]));
              else if (operand.source === "numeric")
                collect(operand.operands as JsonObject[], [...prefix, index, "operands"]);
            });
          collect(expression.operands as JsonObject[], ["operands"]);
          const dependencyIndex = fieldOperandPaths.indexOf(
            pathKey(sourcePath.slice(7, leafIndex)),
          );
          return [
            [...operandBase, "fieldId"],
            [...fieldBase, "dependencyFieldIds", dependencyIndex],
          ];
        }
        return [[...operandBase, leaf]];
      }
      if (sourcePath[7] === "amount" && typeof sourcePath[8] === "string") {
        if (sourcePath[8] === "field")
          return [
            [...expressionBase, "amount", "fieldId"],
            [...fieldBase, "dependencyFieldIds", 1],
          ];
        return [[...expressionBase, "amount", sourcePath[8]]];
      }
    }
  }
  if (
    (source.kind === "module" || source.kind === "application") &&
    sourcePath[0] === "body" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "record_type" &&
    sourcePath.length === 4
  ) {
    const collection = String(sourcePath[1]);
    const collectionMap: Readonly<Record<string, string>> = {
      permissions: "permissions",
      actions: "actions",
      events: "events",
      extension_points: "extensionPoints",
    };
    const canonicalCollection = collectionMap[collection];
    if (canonicalCollection) {
      const targetKey = collection === "actions" ? "subjectRecordTypeId" : "recordTypeId";
      return [["content", canonicalCollection, sourcePath[2], targetKey]];
    }
  }
  if (
    source.kind === "module" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "actions" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "shareable" &&
    sourcePath.length === 4
  )
    return [["content", "actions", sourcePath[2], "sharing"]];
  if (
    (source.kind === "module" || source.kind === "application") &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "events" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "carries" &&
    typeof sourcePath[4] === "number" &&
    sourcePath.length === 5
  )
    return [eventCarriedFieldTarget(source, canonical, sourcePath[2], sourcePath[4], resolution)];
  if (
    (source.kind === "module" || source.kind === "application") &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "actions" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "tasks" &&
    typeof sourcePath[4] === "number" &&
    sourcePath[5] === "properties" &&
    sourcePath[6] === "changes" &&
    typeof sourcePath[7] === "number" &&
    sourcePath[8] === "relationships" &&
    typeof sourcePath[9] === "number" &&
    sourcePath.length === 10
  )
    return [
      [
        "content",
        "actions",
        sourcePath[2],
        "tasks",
        sourcePath[4],
        "properties",
        "changes",
        sourcePath[7],
        "relationshipIds",
        sourcePath[9],
      ],
    ];
  return undefined;
}
