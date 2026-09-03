import type { DefinitionRuleFailureFamily, DefinitionValidationLocation } from "@vortex/contracts";

export const definitionCompilerRefusalCodes = Object.freeze([
  "vortex.definition.ambiguous_definition",
  "vortex.definition.ambiguous_identity",
  "vortex.definition.application_action_references",
  "vortex.definition.application_block_references",
  "vortex.definition.application_block_settings",
  "vortex.definition.application_calendar_mapping",
  "vortex.definition.application_connection_operations",
  "vortex.definition.application_dependency_manifest",
  "vortex.definition.application_event_references",
  "vortex.definition.application_home_page",
  "vortex.definition.application_identity_unique",
  "vortex.definition.application_interface_exposure",
  "vortex.definition.application_interface_method",
  "vortex.definition.application_interface_references",
  "vortex.definition.application_interface_shape",
  "vortex.definition.application_interface_unique",
  "vortex.definition.application_layout_complete",
  "vortex.definition.application_module_bindings",
  "vortex.definition.application_navigation_references",
  "vortex.definition.application_page_permission",
  "vortex.definition.application_page_query",
  "vortex.definition.application_page_references",
  "vortex.definition.application_pipeline_references",
  "vortex.definition.application_pipeline_stage",
  "vortex.definition.application_public_paths",
  "vortex.definition.application_public_surface",
  "vortex.definition.application_query_references",
  "vortex.definition.application_role_references",
  "vortex.definition.application_rule_references",
  "vortex.definition.artifact_binding",
  "vortex.definition.candidate_version_binding",
  "vortex.definition.connection_operation_missing",
  "vortex.definition.connection_lifecycle_operations",
  "vortex.definition.connection_message_shape",
  "vortex.definition.connection_messages_unique",
  "vortex.definition.connection_operation_shapes",
  "vortex.definition.connection_operations_unique",
  "vortex.definition.connection_shape_fields_unique",
  "vortex.definition.connection_shapes_unique",
  "vortex.definition.connection_type_mismatch",
  "vortex.definition.dependency_cycle",
  "vortex.definition.draft_metadata_required",
  "vortex.definition.duplicate_identity_resolution",
  "vortex.definition.duplicate_resolution",
  "vortex.definition.duplicate_source_key",
  "vortex.definition.incompatible_version",
  "vortex.definition.invalid_compilation_output",
  "vortex.definition.invalid_compilation_request",
  "vortex.definition.invalid_object",
  "vortex.definition.invalid_publication_context",
  "vortex.definition.invalid_record_type_reference",
  "vortex.definition.invalid_resolution_fingerprint",
  "vortex.definition.local_identity_unique",
  "vortex.definition.local_references",
  "vortex.definition.missing_definition",
  "vortex.definition.missing_identity",
  "vortex.definition.module_action_references",
  "vortex.definition.module_calculation_acyclic",
  "vortex.definition.module_dependency_acyclic",
  "vortex.definition.module_dependency_resolved",
  "vortex.definition.module_event_references",
  "vortex.definition.module_extension_references",
  "vortex.definition.module_field_references",
  "vortex.definition.module_record_references",
  "vortex.definition.module_relationship_references",
  "vortex.definition.module_rule_references",
  "vortex.definition.module_sharing_condition",
  "vortex.definition.prior_published_version_invalid",
  "vortex.definition.prior_published_version_required",
  "vortex.definition.provenance_complete",
  "vortex.definition.publication_change_required",
  "vortex.definition.publication_context_required",
  "vortex.definition.qualified_field_required",
  "vortex.definition.saved_condition_revision_required",
  "vortex.definition.sharing_condition_field_refused",
  "vortex.definition.sharing_condition_input_refused",
  "vortex.definition.sharing_condition_operator_refused",
  "vortex.definition.sharing_condition_parameter_refused",
  "vortex.definition.source_shape",
  "vortex.definition.source_type_compatibility",
  "vortex.definition.trigger_record_required",
  "vortex.definition.unsafe_duplicate_protection",
  "vortex.definition.unsupported_field_type",
  "vortex.definition.unsupported_workflow_node",
  "vortex.definition.unsupported_workflow_trigger",
  "vortex.definition.workflow_action_inputs",
  "vortex.definition.workflow_child_acyclic",
  "vortex.definition.workflow_child_depth",
  "vortex.definition.workflow_child_reference",
  "vortex.definition.workflow_connection_inputs",
  "vortex.definition.workflow_cycles_bounded",
  "vortex.definition.workflow_edge_endpoints",
  "vortex.definition.workflow_edges_unique",
  "vortex.definition.workflow_node_references",
  "vortex.definition.workflow_node_values",
  "vortex.definition.workflow_outcomes_complete",
  "vortex.definition.workflow_output_dominates",
  "vortex.definition.workflow_output_exists",
  "vortex.definition.workflow_permission",
  "vortex.definition.workflow_reachable",
  "vortex.definition.workflow_single_start",
  "vortex.definition.workflow_stop_terminal",
  "vortex.definition.workflow_termination",
  "vortex.definition.workflow_trigger_reference",
  "vortex.definition.workflow_trigger_values",
] as const);

export type DefinitionCompilerRefusalCode = (typeof definitionCompilerRefusalCodes)[number];

const definitionCompilerRefusalCodeSet: ReadonlySet<string> = new Set(
  definitionCompilerRefusalCodes,
);

export const isDefinitionCompilerRefusalCode = (
  value: string,
): value is DefinitionCompilerRefusalCode => definitionCompilerRefusalCodeSet.has(value);

/**
 * Narrows a rule code from a schema or semantic validator before it crosses
 * the compiler error boundary. This keeps the public error surface closed even
 * where validation produces a dynamically selected rule failure.
 */
export function assertDefinitionCompilerRefusalCode(
  value: string,
): asserts value is DefinitionCompilerRefusalCode {
  if (!isDefinitionCompilerRefusalCode(value)) {
    throw new Error(`Unregistered definition compiler refusal code: ${value}`);
  }
}

export class DefinitionCompilationError extends Error {
  readonly ruleCode: DefinitionCompilerRefusalCode;
  readonly family: DefinitionRuleFailureFamily;
  readonly location: DefinitionValidationLocation | undefined;

  constructor(
    ruleCode: string,
    family: DefinitionRuleFailureFamily,
    location?: DefinitionValidationLocation,
  ) {
    assertDefinitionCompilerRefusalCode(ruleCode);
    super(ruleCode);
    this.name = "DefinitionCompilationError";
    this.ruleCode = ruleCode;
    this.family = family;
    this.location = location;
  }
}
