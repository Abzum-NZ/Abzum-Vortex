import { array, failure, object } from "./helpers";
import type { JsonObject } from "./context";
import { type FlowTask, flowTaskChildLists } from "../../workflows/flow-contracts";
import { flowTaskRegistry } from "../../workflows/flow-task-registry";
import { applicationInterfaceFieldType } from "./action-values";
import type { ApplicationScope } from "./application-scope";

export function applicationInterfaceRules(scope: ApplicationScope): void {
  const {
    content,
    allFields,
    fieldValuePairs,
    permissionMap,
    permissions,
    actions,
    publicPermissionSafe,
    publicActionSafe,
    publicQuerySafe,
    flowsForCommits,
    moduleQueries,
    output,
    failures,
  } = scope;

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
    if (["whole_number"].includes(value)) return "whole_number";
    if (value === "yes_no") return "yes_no";
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
    const operationPaths = array(definition.operations).map((operation) => String(operation.path));
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
          failure(output, "vortex.definition.application_interface_references", "broken_reference"),
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
          bindingsByInputKey.set(key, [...(bindingsByInputKey.get(key) ?? []), object(descriptor)]);
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
}
