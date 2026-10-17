import {
  sourceFlowCollectionSchema,
  type ModuleCompilationOutput,
  type DefinitionCompilationOutput,
} from "../../schema";
import { fingerprintCanonicalValue } from "../canonical-json-definition";
import { DefinitionCompilationError } from "../compilation-error";
import {
  compileFlowSources,
  type ResolvedFlowFieldMetadata,
  type ResolvedFlowIdentity,
} from "../flow-compilation";
import {
  findActionInputsIssue,
  findOperationCallIssue,
  namedActionInputs,
  platformOperationLookup,
} from "../flow-operation-calls";
import { flowIssueLocation } from "../flow-validation";
import { dependencyOrder } from "./dependencies";
import type { Resolution } from "./resolution";
import { compatibleVersion } from "./resolution";
import {
  applicationModuleKeysOf,
  asObject,
  CURRENT_MODULE_RELEASE,
  fail,
  type JsonObject,
} from "./shared";
import { moduleDependencies } from "../module-dependencies";

/**
 * Compiles the flows a module or application owns to permanent identities, refusing an
 * unresolved alias, an unregistered task or a reference outside the declared dependencies. The
 * canonical flows go into the definition's content and their provenance into its provenance; the
 * dependency manifest contribution only ever names definitions the source already declares, so
 * the definition's own resolved dependencies stay the one record of exact releases.
 */
function compileOwnedFlowSources(
  source: JsonObject,
  resolution: Resolution,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
) {
  const parsed = sourceFlowCollectionSchema.safeParse(asObject(source.body).flows);
  if (!parsed.success) fail("vortex.definition.source_shape", "invalid_value");
  const ownKey = String(source.key);
  const declaredDefinitionKeys = dependencyOrder(source).filter((key) => key !== ownKey);
  const declaredDefinitionKeySet = new Set(declaredDefinitionKeys);
  const body = asObject(source.body);
  const moduleDependencyEntries =
    source.kind === "module"
      ? (moduleDependencies(source) as unknown as JsonObject[])
      : source.kind === "application"
        ? applicationModuleKeysOf(body).map((module) => ({ module, version: CURRENT_MODULE_RELEASE }))
        : [];
  const dependencyModuleOutput = (moduleKey: string): ModuleCompilationOutput => {
    const bindings = moduleDependencyEntries.filter(
      (binding) => String(binding.module) === moduleKey,
    );
    if (moduleKey === ownKey || !declaredDefinitionKeySet.has(moduleKey) || bindings.length !== 1)
      fail("vortex.definition.application_dependency_manifest", "broken_reference");
    const snapshotMatches = resolution.snapshot.definitions.filter(
      (definition) => definition.kind === "module" && definition.key === moduleKey,
    );
    if (snapshotMatches.length !== 1)
      fail("vortex.definition.application_dependency_manifest", "broken_reference");
    const expected = resolution.definition(moduleKey, "module");
    const requirement = bindings[0]!.version as Parameters<typeof compatibleVersion>[0];
    if (!compatibleVersion(requirement, expected.exactVersion))
      fail("vortex.definition.application_dependency_manifest", "broken_reference");

    const candidates = dependencyOutputs.filter(
      (output): output is ModuleCompilationOutput =>
        output.kind === "module" && output.artifact.definitionKey === moduleKey,
    );
    if (candidates.length !== 1)
      fail("vortex.definition.application_dependency_manifest", "broken_reference");
    const output = candidates[0]!;
    const canonical = asObject(output.canonical);
    const envelope = asObject(canonical.envelope);
    const content = asObject(canonical.content);
    if (
      output.artifact.rootId !== expected.rootId ||
      output.artifact.exactVersion !== expected.exactVersion ||
      output.artifact.resolutionFingerprint !== output.resolutionFingerprint ||
      output.artifact.contentFingerprint !== fingerprintCanonicalValue(content) ||
      // The Module kind belongs to the canonical envelope, not the canonical draft root.
      envelope.kind !== "module" ||
      envelope.key !== moduleKey ||
      envelope.rootId !== expected.rootId
    )
      fail("vortex.definition.application_dependency_manifest", "broken_reference");
    return output;
  };
  const fieldMetadataById = new Map<string, ResolvedFlowFieldMetadata[]>();
  const addFieldMetadata = (metadata: ResolvedFlowFieldMetadata) => {
    const matches = fieldMetadataById.get(metadata.identifier);
    if (matches === undefined) fieldMetadataById.set(metadata.identifier, [metadata]);
    else matches.push(metadata);
  };
  for (const recordType of Array.isArray(body.record_types)
    ? (body.record_types as JsonObject[])
    : []) {
    const recordKey = String(recordType.key);
    const qualifiedRecordType = `${ownKey}:${recordKey}`;
    const recordTypeId = resolution.recordType(qualifiedRecordType).recordTypeId;
    for (const field of recordType.fields as JsonObject[])
      addFieldMetadata({
        identifier: resolution.field(qualifiedRecordType, String(field.id)),
        recordTypeId,
        type: String(field.type),
      });
  }
  for (const output of dependencyOutputs) {
    if (output.kind !== "module" || !declaredDefinitionKeySet.has(output.artifact.definitionKey))
      continue;
    for (const recordType of output.canonical.content.recordTypes as unknown as JsonObject[])
      for (const field of recordType.fields as JsonObject[])
        addFieldMetadata({
          identifier: String(field.fieldId),
          recordTypeId: String(recordType.recordTypeId),
          type: String(field.type),
        });
  }
  const owned = (kind: string, alias: string): ResolvedFlowIdentity => {
    const split = alias.indexOf(":");
    const definitionKey = split < 1 ? ownKey : alias.slice(0, split);
    return {
      identifier: resolution.id(definitionKey, kind, alias.slice(split + 1), "content"),
      definitionKey,
    };
  };
  const qualifiedRecord = (reference: string) =>
    reference.includes(":") ? reference : `${ownKey}:${reference}`;
  const recordOwner = (reference: string) => qualifiedRecord(reference).split(":")[0]!;
  return compileFlowSources({
    flows: parsed.data,
    declaredDefinitionKeys,
    resolver: {
      definitionKey: ownKey,
      flow: (alias) => owned("flow", alias),
      recordType: (reference) => ({
        identifier: resolution.recordType(qualifiedRecord(reference)).recordTypeId,
        definitionKey: recordOwner(reference),
      }),
      field: (record, alias) => ({
        identifier: resolution.field(qualifiedRecord(record), alias),
        definitionKey: recordOwner(record),
      }),
      fieldMetadata: (fieldId) => fieldMetadataById.get(fieldId) ?? [],
      dependencyFieldMetadata: (definitionKey, fieldId) => {
        const moduleOutput = dependencyModuleOutput(definitionKey);
        return (moduleOutput.canonical.content.recordTypes as unknown as JsonObject[]).flatMap(
          (recordType) =>
            (recordType.fields as JsonObject[])
              .filter((field) => String(field.fieldId) === fieldId)
              .map((field) => ({
                identifier: String(field.fieldId),
                recordTypeId: String(recordType.recordTypeId),
                type: String(field.type),
              })),
        );
      },
      relationship: (record, alias) => ({
        identifier: resolution.relationship(qualifiedRecord(record), alias),
        definitionKey: recordOwner(record),
      }),
      action: (alias) => owned("action", alias),
      permission: (alias) => owned("permission", alias),
      query: (alias) => owned("query", alias),
      page: (alias) => owned("page", alias),
      // A form is the page placement that holds it.
      form: (alias) => owned("block_placement", alias),
      connectionBinding: (alias) => owned("connection_binding", alias),
      executionBinding: (alias) => owned("execution_binding", alias),
      locate: (flowKey) => resolution.location("flow", flowKey),
    },
  });
}

/**
 * Compiles the flows a definition owns and proves that every operation they call exists: a
 * registered platform-service operation, or a named action of this definition or of a Module it
 * declares as a dependency. A flow that calls anything else is refused here, on the task.
 */
export function compileCheckedFlowSources(
  source: JsonObject,
  resolution: Resolution,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
) {
  const flowSet = compileOwnedFlowSources(source, resolution, dependencyOutputs);
  const actions = new Map<string, ReturnType<typeof namedActionInputs>>();
  const remember = (candidates: unknown) => {
    for (const action of (Array.isArray(candidates) ? candidates : []) as JsonObject[])
      actions.set(
        String(action.key),
        namedActionInputs(
          (Array.isArray(action.inputs) ? (action.inputs as JsonObject[]) : []).map((input) => ({
            key: String(input.key),
            required: input.required === true,
          })),
        ),
      );
  };
  remember(asObject(source.body).actions);
  for (const output of dependencyOutputs)
    if (output.kind === "module") remember(output.canonical.content.actions);
  const issue = findOperationCallIssue(
    flowSet.flows,
    // Only an Application pins a platform operation's release in its manifest, so only an
    // Application may call one.
    (key) =>
      (source.kind === "application" ? platformOperationLookup(key) : undefined) ??
      actions.get(key),
  );
  if (issue !== undefined)
    throw new DefinitionCompilationError(
      issue.ruleCode,
      issue.family,
      flowIssueLocation(resolution.location("flow", issue.flowKey), { taskId: issue.taskId }),
    );
  // The named action that owns each option, by record type, field key and option, for Save record
  // tasks that supply the action's inputs (a Save record task names its fields by key).
  const optionActions = new Map<string, Map<string, { required: boolean; type: string }>>();
  const optionKey = (recordTypeId: string, fieldKey: string, option: string) =>
    `${recordTypeId.toLowerCase()} ${fieldKey.toLowerCase()} ${option}`;
  const rememberOption = (
    recordTypeId: string,
    fieldKey: string,
    option: string,
    inputs: unknown,
  ) =>
    optionActions.set(
      optionKey(recordTypeId, fieldKey, option),
      new Map(
        (Array.isArray(inputs) ? (inputs as JsonObject[]) : []).map((input) => [
          String(input.key),
          { required: input.required === true, type: String(input.type) },
        ]),
      ),
    );
  if (source.kind === "module")
    for (const action of (asObject(source.body).actions ?? []) as JsonObject[]) {
      if (action.sets_choice_field === undefined) continue;
      const record = `${String(source.key)}:${String(action.record_type)}`;
      rememberOption(
        resolution.recordType(record).recordTypeId,
        String(action.sets_choice_field),
        String(action.sets_choice_option),
        action.inputs,
      );
    }
  for (const output of dependencyOutputs)
    if (output.kind === "module") {
      const fieldKeys = new Map(
        (output.canonical.content.recordTypes as unknown as JsonObject[]).flatMap((recordType) =>
          (recordType.fields as JsonObject[]).map(
            (field) => [String(field.fieldId).toLowerCase(), String(field.key)] as const,
          ),
        ),
      );
      for (const action of output.canonical.content.actions as unknown as JsonObject[]) {
        const fieldKey =
          action.setsChoiceFieldId === undefined
            ? undefined
            : fieldKeys.get(String(action.setsChoiceFieldId).toLowerCase());
        if (fieldKey !== undefined)
          rememberOption(
            String(action.subjectRecordTypeId),
            fieldKey,
            String(action.setsChoiceOption),
            action.inputs,
          );
      }
    }
  const actionInputsIssue = findActionInputsIssue(flowSet.flows, (recordTypeId, fieldKey, option) =>
    optionActions.get(optionKey(recordTypeId, fieldKey, option)),
  );
  if (actionInputsIssue !== undefined)
    throw new DefinitionCompilationError(
      actionInputsIssue.ruleCode,
      actionInputsIssue.family,
      flowIssueLocation(resolution.location("flow", actionInputsIssue.flowKey), {
        taskId: actionInputsIssue.taskId,
      }),
    );
  return flowSet;
}
