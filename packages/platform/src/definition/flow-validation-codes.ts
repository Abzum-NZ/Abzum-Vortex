import type { DefinitionRuleFailureFamily } from "../catalogue/validation-errors";
import type { FlowTaskPlacementIssue } from "../workflows/flow-task-registry";
import type { DefinitionCompilerRefusalCode } from "./compilation-error";

export const placementCodes: Readonly<
  Record<
    FlowTaskPlacementIssue["code"],
    readonly [DefinitionCompilerRefusalCode, DefinitionRuleFailureFamily]
  >
> = {
  unknown_task_type: ["vortex.definition.unsupported_workflow_node", "unsupported_choice"],
  unsupported_task_version: ["vortex.definition.incompatible_version", "incompatible_version"],
  wrong_run_location: ["vortex.definition.workflow_node_references", "invalid_value"],
  unknown_property: ["vortex.definition.workflow_node_values", "unknown_property"],
  missing_property: ["vortex.definition.workflow_node_values", "required_value"],
  saved_record_target: ["vortex.definition.workflow_node_values", "invalid_value"],
  refusal_not_possible: ["vortex.definition.workflow_node_values", "invalid_value"],
};

export const callCodes = {
  cycle: ["vortex.definition.workflow_child_acyclic", "dependency_cycle"],
  depth_exceeded: ["vortex.definition.workflow_child_depth", "too_many_items"],
  transaction_calls_non_transaction: [
    "vortex.definition.workflow_child_reference",
    "invalid_value",
  ],
} as const satisfies Record<
  string,
  readonly [DefinitionCompilerRefusalCode, DefinitionRuleFailureFamily]
>;
