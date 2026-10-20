import { applicationCatalogueRuleCodes } from "./application-catalogue-validation";
import type { createContractValueWalker } from "./contract-value-walker";
import {
  type DefinitionRuleFailure,
  type DefinitionPublicationContext,
  definitionPublicationContextSchema,
  moduleCompilationRequestSchema,
  applicationCompilationRequestSchema,
  definitionCompilationRequestSchema,
} from "../schema";
import { settleDefinitionRuleFailures } from "./rule-failure-order";
import { DefinitionCompilationError } from "./compilation-error";
import { compareCanonicalStrings } from "./canonical-json-definition";
import { compileParsedDefinition } from "./compiler";
import type { PlatformPermissionSource } from "../access/platform-permissions";
import {
  type DefinitionSemanticRule,
  type DefinitionValidationStage,
  type DefinitionSetValidationContext,
  type PreparedValidationContext,
  editSaveSources,
  parseEditSaveSource,
  canonicalValueWalker,
  type PublicationCompilationRequest,
  type JsonObject,
  type Output,
  isModuleSource,
  isApplicationSource,
} from "./validation/context";
import {
  sourceShapeRule,
  pinnedModulePermissionIdRule,
  localIdentityRule,
  artifactBindingRule,
} from "./validation/source-rules";
import { sourceLocalReferenceRule } from "./validation/source-references";
import { sourceTypeCompatibilityRule } from "./validation/source-types";
import {
  applicationCatalogueRule,
  publicationContextRule,
  semanticAggregateRule,
  moduleRuleCodes,
  applicationRuleCodes,
  connectionRuleCodes,
  connectionRule,
  publicationCompatibilityRule,
} from "./validation/publication-rules";
import {
  applicationFlowBindingEventRule,
  applicationControlBindingRule,
} from "./validation/application-blocks";
import { dependencyRule, provenanceRule } from "./validation/provenance-rules";
import { moduleReferenceRule } from "./validation/module-references";
import { applicationRule } from "./validation/application-rule";
import { object, array } from "./validation/helpers";
import { moduleDependencies } from "./module-dependencies";

export const definitionSemanticRules: readonly DefinitionSemanticRule[] = Object.freeze([
  {
    ruleId: "vortex.definition.source_shape",
    emittedCodes: ["vortex.definition.source_shape"],
    stage: "edit_save",
    definitionKinds: ["module", "application", "connection_type"],
    requiredContext: ["source"],
    safeLocationFamily: "document",
    run: sourceShapeRule,
  },
  {
    ruleId: "vortex.definition.pinned_module_permission_id",
    emittedCodes: ["vortex.definition.source_shape"],
    stage: "edit_save",
    definitionKinds: ["module"],
    requiredContext: ["source"],
    safeLocationFamily: "document",
    run: pinnedModulePermissionIdRule,
  },
  {
    ruleId: "vortex.definition.local_identity_unique",
    emittedCodes: ["vortex.definition.local_identity_unique"],
    stage: "edit_save",
    definitionKinds: ["module", "application", "connection_type"],
    requiredContext: ["source"],
    safeLocationFamily: "document",
    run: localIdentityRule,
  },
  {
    ruleId: "vortex.definition.local_references",
    emittedCodes: ["vortex.definition.local_references"],
    stage: "edit_save",
    definitionKinds: ["module", "application", "connection_type"],
    requiredContext: ["source"],
    safeLocationFamily: "document",
    run: sourceLocalReferenceRule,
  },
  {
    ruleId: "vortex.definition.source_type_compatibility",
    emittedCodes: ["vortex.definition.source_type_compatibility"],
    stage: "edit_save",
    definitionKinds: ["module"],
    requiredContext: ["source"],
    safeLocationFamily: "document",
    run: sourceTypeCompatibilityRule,
  },
  {
    ruleId: "vortex.definition.application_catalogue",
    emittedCodes: applicationCatalogueRuleCodes,
    stage: "edit_save",
    definitionKinds: ["application"],
    requiredContext: ["source"],
    safeLocationFamily: "application",
    run: applicationCatalogueRule,
  },
  {
    ruleId: "vortex.definition.application_flow_binding_events",
    emittedCodes: ["vortex.definition.application_flow_binding_event"],
    stage: "edit_save",
    definitionKinds: ["application"],
    requiredContext: ["source"],
    safeLocationFamily: "flow_binding",
    run: applicationFlowBindingEventRule,
  },
  {
    ruleId: "vortex.definition.application_control_bindings",
    emittedCodes: ["vortex.definition.application_control_binding"],
    stage: "publish",
    definitionKinds: ["application"],
    requiredContext: ["source"],
    safeLocationFamily: "block",
    run: applicationControlBindingRule,
  },
  {
    ruleId: "vortex.definition.publication_context_required",
    emittedCodes: ["vortex.definition.publication_context_required"],
    stage: "publish",
    definitionKinds: ["module", "application", "connection_type"],
    requiredContext: ["compiled_set"],
    safeLocationFamily: "document",
    run: publicationContextRule,
  },
  semanticAggregateRule(
    "vortex.definition.artifact_binding",
    ["vortex.definition.artifact_binding"],
    "publish",
    ["module", "application", "connection_type"],
    ["compiled_set"],
    "document",
    artifactBindingRule,
  ),
  semanticAggregateRule(
    "vortex.definition.module_dependencies",
    ["vortex.definition.module_dependency_acyclic", "vortex.definition.module_dependency_resolved"],
    "publish",
    ["module"],
    ["compiled_set"],
    "module",
    dependencyRule,
  ),
  semanticAggregateRule(
    "vortex.definition.module_references",
    moduleRuleCodes.filter((code) => !code.startsWith("vortex.definition.module_dependency_")),
    "publish",
    ["module"],
    ["compiled_set"],
    "module",
    moduleReferenceRule,
  ),
  {
    ruleId: "vortex.definition.provenance_complete",
    emittedCodes: ["vortex.definition.provenance_complete"],
    stage: "publish",
    definitionKinds: ["module", "application", "connection_type"],
    requiredContext: ["source", "resolution_snapshot", "compiled_set"],
    safeLocationFamily: "document",
    run: provenanceRule,
  },
  semanticAggregateRule(
    "vortex.definition.application_semantics",
    applicationRuleCodes,
    "publish",
    ["application"],
    ["source", "resolution_snapshot", "compiled_set"],
    "application",
    applicationRule,
  ),
  semanticAggregateRule(
    "vortex.definition.connection_semantics",
    connectionRuleCodes,
    "publish",
    ["connection_type"],
    ["compiled_set"],
    "connection",
    connectionRule,
  ),
  semanticAggregateRule(
    "vortex.definition.publication_compatibility",
    [
      "vortex.definition.prior_published_version_required",
      "vortex.definition.prior_published_version_invalid",
      "vortex.definition.publication_change_required",
      "vortex.definition.candidate_version_binding",
    ],
    "publish",
    ["module", "application"],
    ["compiled_set", "prior_published_version"],
    "document",
    publicationCompatibilityRule,
  ),
]);

const validationStageRank: Readonly<Record<DefinitionValidationStage, number>> = {
  edit_save: 0,
  publish: 1,
  install: 2,
  runtime: 3,
};

function hasRequiredContext(
  context: DefinitionSetValidationContext,
  required: DefinitionSemanticRule["requiredContext"],
): boolean {
  return required.every((item) => {
    if (item === "source") return context.rawSources !== undefined || context.requests.length > 0;
    if (item === "resolution_snapshot") return context.requests.length > 0;
    if (item === "compiled_set") return context.outputs.length > 0;
    if (item === "prior_published_version")
      return (
        context.publishedHistories !== undefined || context.publishedHistoryEvidence !== undefined
      );
    return false;
  });
}

export function validateDefinitionSet(
  context: DefinitionSetValidationContext,
  stage: DefinitionValidationStage = "publish",
) {
  return validatePreparedDefinitionSet(
    {
      ...context,
      parsedSources: editSaveSources(context).map((source) => parseEditSaveSource(source)),
    },
    stage,
  );
}

function validatePreparedDefinitionSet(
  context: PreparedValidationContext,
  stage: DefinitionValidationStage,
) {
  const eligibleRules = definitionSemanticRules
    .filter((rule) => validationStageRank[rule.stage] <= validationStageRank[stage])
    .filter((rule) => hasRequiredContext(context, rule.requiredContext));
  // The boundary supplies one parse per source, shared by every edit-save rule. The canonical
  // walker is built on first use, so rules that never walk the compiled set still build none.
  let canonicalWalker: ReturnType<typeof createContractValueWalker> | undefined;
  const preparedContext: PreparedValidationContext = {
    ...context,
    walkCanonicalValues: (value, visit) =>
      (canonicalWalker ??= canonicalValueWalker(context))(value, visit),
  };
  const failures: DefinitionRuleFailure[] = [];
  for (const rule of eligibleRules) failures.push(...rule.run(preparedContext));
  const sorted = settleDefinitionRuleFailures(failures);
  return { valid: sorted.length === 0, failures: sorted } as const;
}

export function validateDefinitionSource(source: unknown, permissions: PlatformPermissionSource) {
  const parsed = parseEditSaveSource(source);
  const validation = validatePreparedDefinitionSet(
    { permissions, requests: [], outputs: [], rawSources: [source], parsedSources: [parsed] },
    "edit_save",
  );
  // Only this unknown-input boundary produces the detached source used by draft storage.
  return { ...validation, source: validation.valid && parsed.success ? parsed.data : undefined };
}

function dependencyKeys(request: PublicationCompilationRequest): string[] {
  const source = request.source as unknown as JsonObject;
  const body = object(source.body);
  if (source.kind === "module") return moduleDependencies(source).map((entry) => entry.module);
  if (source.kind === "application")
    return [
      ...array(body.modules).map((module) => String(module.key)),
      ...array(body.uses).map((use) => String(use.module)),
      ...array(body.connection_bindings).map((entry) => String(entry.connection_type)),
    ];
  return [];
}

export function compileDefinitionSet(
  inputs: readonly PublicationCompilationRequest[],
  options: DefinitionPublicationContext | undefined,
  permissions: PlatformPermissionSource,
): Output[] {
  if (!Array.isArray(inputs))
    throw new DefinitionCompilationError(
      "vortex.definition.invalid_compilation_request",
      "invalid_value",
    );
  if (options === undefined)
    throw new DefinitionCompilationError(
      "vortex.definition.publication_context_required",
      "required_value",
    );
  const parsedContext = definitionPublicationContextSchema.safeParse(options);
  if (!parsedContext.success)
    throw new DefinitionCompilationError(
      "vortex.definition.invalid_publication_context",
      "invalid_value",
    );
  const publicationContext = parsedContext.data;
  const parsedInputs = inputs.map((input) => {
    const source = object(input).source;
    if (isModuleSource(source)) return moduleCompilationRequestSchema.safeParse(input);
    if (isApplicationSource(source)) return applicationCompilationRequestSchema.safeParse(input);
    return definitionCompilationRequestSchema.safeParse(input);
  });
  if (parsedInputs.some((result) => !result.success))
    throw new DefinitionCompilationError(
      "vortex.definition.invalid_compilation_request",
      "invalid_value",
    );
  const requests = parsedInputs.flatMap((result) => (result.success ? [result.data] : []));
  const byKey = new Map(requests.map((input) => [input.source.key, input]));
  if (byKey.size !== requests.length)
    throw new DefinitionCompilationError("vortex.definition.duplicate_source_key", "duplicate_key");
  const ordered: PublicationCompilationRequest[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key))
      throw new DefinitionCompilationError(
        "vortex.definition.dependency_cycle",
        "dependency_cycle",
      );
    if (visited.has(key)) return;
    const input = byKey.get(key);
    if (!input) return;
    visiting.add(key);
    dependencyKeys(input).sort(compareCanonicalStrings).forEach(visit);
    visiting.delete(key);
    visited.add(key);
    ordered.push(input);
  };
  [...byKey.keys()].sort(compareCanonicalStrings).forEach(visit);
  const dependencyOutputs = publicationContext.dependencyOutputs ?? [];
  const inputKeys = new Set(ordered.map((request) => request.source.key));
  if (dependencyOutputs.some((output) => inputKeys.has(output.artifact.definitionKey)))
    throw new DefinitionCompilationError("vortex.definition.duplicate_source_key", "duplicate_key");
  const outputs: Output[] = [];
  // Each request was parsed above and the dependency outputs came out of the publication context
  // schema, so the compiler is not asked to parse either a second time.
  const compilePublicationRequest = compileParsedDefinition as (
    request: PublicationCompilationRequest,
    dependencyOutputs: readonly Output[],
    permissions: PlatformPermissionSource,
  ) => Output;
  for (const request of ordered)
    outputs.push(
      compilePublicationRequest(request, [...dependencyOutputs, ...outputs], permissions),
    );
  const validation = validateDefinitionSet({
    permissions,
    requests: ordered,
    outputs,
    ...(dependencyOutputs.length === 0 ? {} : { dependencyOutputs }),
    publishedHistories: publicationContext.publishedHistories,
  });
  if (!validation.valid) {
    const first = validation.failures[0]!;
    throw new DefinitionCompilationError(first.ruleCode, first.family, first.location);
  }
  return outputs;
}
