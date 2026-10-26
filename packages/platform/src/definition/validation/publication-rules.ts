import type { DefinitionRuleFailure } from "../../catalogue/validation-errors";
import type {
  ModuleCompilationOutput,
  ApplicationCompilationOutput,
} from "../definition-compilation-contracts";
import type { ApplicationSourceDocument } from "../definition-source";
import type { VersionRequirement } from "../definitions";
import { gt, lt, satisfies } from "semver";
import {
  compareDefinitionVersionImpactWithEvidence,
  compareDefinitionVersionImpact,
} from "../version-impact-definition";
import { validateApplicationSourceCatalogue } from "../application-catalogue-validation";
import {
  type DefinitionSetValidationContext,
  type DefinitionValidationStage,
  type DefinitionSemanticRule,
  type PreparedValidationContext,
  editSaveSources,
  parseEditSaveSource,
  isApplicationSource,
} from "./context";
import { object, array, failure, outputKey } from "./helpers";

export const moduleRuleCodes = [
  "vortex.definition.module_dependency_acyclic",
  "vortex.definition.module_dependency_resolved",
  "vortex.definition.module_record_references",
  "vortex.definition.module_relationship_references",
  "vortex.definition.module_field_references",
  "vortex.definition.module_calculation_acyclic",
  "vortex.definition.module_action_references",
  "vortex.definition.module_event_references",
  "vortex.definition.module_extension_capabilities",
  "vortex.definition.module_extension_references",
  "vortex.definition.module_sharing_condition",
  "vortex.definition.module_query_references",
  "vortex.definition.module_query_group_field_type",
  "vortex.definition.module_query_derived_aggregate_source",
  "vortex.definition.module_query_numeric_aggregate_field_type",
  "vortex.definition.module_query_extrema_field_type",
  "vortex.definition.module_query_distinct_field_filterable",
] as const;

export const applicationRuleCodes = [
  "vortex.definition.application_identity_unique",
  "vortex.definition.application_dependency_manifest",
  "vortex.definition.application_module_bindings",
  "vortex.definition.application_action_references",
  "vortex.definition.application_event_references",
  "vortex.definition.application_home_page",
  "vortex.definition.application_role_references",
  "vortex.definition.application_navigation_references",
  "vortex.definition.application_query_references",
  "vortex.definition.application_query_exposure",
  "vortex.definition.application_page_permission",
  "vortex.definition.application_page_query",
  "vortex.definition.application_page_references",
  "vortex.definition.application_layout_complete",
  "vortex.definition.application_block_references",
  "vortex.definition.application_block_settings",
  "vortex.definition.application_public_surface",
  "vortex.definition.application_connection_operations",
  "vortex.definition.application_public_paths",
  "vortex.definition.application_interface_references",
  "vortex.definition.application_interface_shape",
  "vortex.definition.application_interface_exposure",
  "vortex.definition.application_interface_unique",
  "vortex.definition.application_interface_method",
  "vortex.definition.workflow_single_start",
  "vortex.definition.workflow_edges_unique",
  "vortex.definition.workflow_edge_endpoints",
  "vortex.definition.workflow_reachable",
  "vortex.definition.workflow_stop_terminal",
  "vortex.definition.workflow_outcomes_complete",
  "vortex.definition.workflow_output_exists",
  "vortex.definition.workflow_output_dominates",
  "vortex.definition.workflow_termination",
  "vortex.definition.workflow_cycles_bounded",
  "vortex.definition.workflow_trigger_values",
  "vortex.definition.workflow_trigger_reference",
  "vortex.definition.workflow_permission",
  "vortex.definition.workflow_node_references",
  "vortex.definition.workflow_node_values",
  "vortex.definition.workflow_action_inputs",
  "vortex.definition.workflow_connection_inputs",
  "vortex.definition.workflow_child_acyclic",
  "vortex.definition.workflow_child_depth",
  "vortex.definition.workflow_child_reference",
  "vortex.definition.application_flow_binding_target",
  "vortex.definition.application_flow_binding_inputs",
] as const;

export const connectionRuleCodes = [
  "vortex.definition.connection_shapes_unique",
  "vortex.definition.connection_shape_fields_unique",
  "vortex.definition.connection_operations_unique",
  "vortex.definition.connection_messages_unique",
  "vortex.definition.connection_operation_shapes",
  "vortex.definition.connection_message_shape",
  "vortex.definition.connection_lifecycle_operations",
] as const;

export function connectionRule(context: DefinitionSetValidationContext): DefinitionRuleFailure[] {
  const failures: DefinitionRuleFailure[] = [];
  for (const output of context.outputs.filter(
    (candidate) => candidate.kind === "connection_type",
  )) {
    const connection = object(output.canonical);
    const shapes = array(connection.shapes);
    const operations = array(connection.operations);
    const messages = array(connection.incomingMessages);
    const shapeKeys = shapes.map((shape) => String(shape.key));
    const operationKeys = operations.map((operation) => String(operation.key));
    if (new Set(shapeKeys).size !== shapeKeys.length)
      failures.push(failure(output, "vortex.definition.connection_shapes_unique", "duplicate_key"));
    if (
      shapes.some((shape) => {
        const keys = array(shape.fields).map((field) => String(field.key));
        return new Set(keys).size !== keys.length;
      })
    )
      failures.push(
        failure(output, "vortex.definition.connection_shape_fields_unique", "duplicate_key"),
      );
    if (new Set(operationKeys).size !== operationKeys.length)
      failures.push(
        failure(output, "vortex.definition.connection_operations_unique", "duplicate_key"),
      );
    const messageKeys = messages.map((message) => String(message.key));
    if (new Set(messageKeys).size !== messageKeys.length)
      failures.push(
        failure(output, "vortex.definition.connection_messages_unique", "duplicate_key"),
      );
    const knownShapes = new Set(shapeKeys);
    if (
      operations.some(
        (operation) =>
          !knownShapes.has(String(operation.inputShapeKey)) ||
          !knownShapes.has(String(operation.outputShapeKey)),
      )
    )
      failures.push(
        failure(output, "vortex.definition.connection_operation_shapes", "broken_reference"),
      );
    if (messages.some((message) => !knownShapes.has(String(message.inputShapeKey))))
      failures.push(
        failure(output, "vortex.definition.connection_message_shape", "broken_reference"),
      );
    const knownOperations = new Set(operationKeys);
    if (
      [connection.healthOperationKey, connection.revocationOperationKey].some(
        (key) => key !== undefined && !knownOperations.has(String(key)),
      )
    )
      failures.push(
        failure(output, "vortex.definition.connection_lifecycle_operations", "broken_reference"),
      );
  }
  return failures;
}

export function versionRequirementAccepts(
  requirement: VersionRequirement,
  version: string,
): boolean {
  return requirement.selection === "exact"
    ? requirement.version === version
    : satisfies(version, requirement.expression, { includePrerelease: false });
}

export function publicationCompatibilityRule(
  context: DefinitionSetValidationContext,
): DefinitionRuleFailure[] {
  const failures: DefinitionRuleFailure[] = [];
  for (const output of context.outputs.filter(
    (candidate): candidate is ModuleCompilationOutput | ApplicationCompilationOutput =>
      candidate.kind === "module" || candidate.kind === "application",
  )) {
    const key = outputKey(output);
    const history = context.publishedHistories?.find(
      (candidate) => candidate.definitionKey === key && candidate.kind === output.kind,
    );
    const releaseHistory = context.publishedHistoryEvidence?.find(
      (candidate) => candidate.definitionKey === key && candidate.kind === output.kind,
    );
    if (!history && !releaseHistory) {
      failures.push(
        failure(output, "vortex.definition.prior_published_version_required", "required_value"),
      );
      continue;
    }
    try {
      const result = releaseHistory
        ? compareDefinitionVersionImpactWithEvidence({
            kind: output.kind,
            validationContractVersion: output.validationContractVersion,
            releaseHistory,
            candidate: output.canonical,
          })
        : output.kind === "module" && history?.kind === "module"
          ? compareDefinitionVersionImpact({
              kind: "module",
              validationContractVersion: output.validationContractVersion,
              history: history.history,
              candidate: output.canonical,
            })
          : output.kind === "application" && history?.kind === "application"
            ? compareDefinitionVersionImpact({
                kind: "application",
                validationContractVersion: output.validationContractVersion,
                history: history.history,
                candidate: output.canonical,
              })
            : undefined;
      if (!result) {
        failures.push(
          failure(output, "vortex.definition.prior_published_version_invalid", "invalid_value"),
        );
        continue;
      }
      // One Application publication assigns one version to the Application and every inline
      // Module it releases, from all of their changes together. So a candidate's version must be
      // new, and at least what its own changes require; an Application whose only changes are in
      // its Modules is released at the version their changes assign.
      if (result.outcome === "no_change") {
        if (gt(output.artifact.exactVersion, result.currentVersion)) continue;
        failures.push(
          failure(output, "vortex.definition.publication_change_required", "invalid_value"),
        );
        continue;
      }
      if (lt(output.artifact.exactVersion, result.assignedVersion)) {
        failures.push(
          failure(output, "vortex.definition.candidate_version_binding", "incompatible_version"),
        );
        continue;
      }
      // guard-allow: silent-catch An unparseable prior version is reported as a publication failure.
    } catch {
      failures.push(
        failure(output, "vortex.definition.prior_published_version_invalid", "invalid_value"),
      );
    }
  }
  return failures;
}

export function publicationContextRule(
  context: DefinitionSetValidationContext,
): DefinitionRuleFailure[] {
  const publishesVersionedDefinition = context.outputs.some(
    (output) => output.kind === "module" || output.kind === "application",
  );
  if (
    context.requests.length > 0 &&
    context.outputs.length > 0 &&
    (!publishesVersionedDefinition ||
      context.publishedHistories !== undefined ||
      context.publishedHistoryEvidence !== undefined)
  )
    return [];
  const output = context.outputs[0];
  return [
    output
      ? failure(output, "vortex.definition.publication_context_required", "required_value")
      : {
          ruleCode: "vortex.definition.publication_context_required",
          family: "required_value",
        },
  ];
}

export function semanticAggregateRule(
  ruleId: string,
  emittedCodes: readonly string[],
  stage: DefinitionValidationStage,
  definitionKinds: DefinitionSemanticRule["definitionKinds"],
  requiredContext: DefinitionSemanticRule["requiredContext"],
  safeLocationFamily: DefinitionSemanticRule["safeLocationFamily"],
  aggregateRunner: DefinitionSemanticRule["run"],
): DefinitionSemanticRule {
  return {
    ruleId,
    emittedCodes,
    stage,
    definitionKinds,
    requiredContext,
    safeLocationFamily,
    run: aggregateRunner,
  };
}

export function applicationCatalogueRule(
  context: PreparedValidationContext,
): DefinitionRuleFailure[] {
  return editSaveSources(context).flatMap((source, index) => {
    const parsed = context.parsedSources?.[index] ?? parseEditSaveSource(source);
    return parsed.success && isApplicationSource(parsed.data)
      ? validateApplicationSourceCatalogue(parsed.data as ApplicationSourceDocument)
      : [];
  });
}
