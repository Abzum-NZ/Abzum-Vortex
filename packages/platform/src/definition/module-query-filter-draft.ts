import "server-only";

import type { moduleCompilationRequestSchema } from "../schema";
import {
  moduleRootIdSchema,
  moduleSourceDocumentSchema,
  sourceConditionSchema,
  queryIdSchema,
  conditionNodeSchema,
  fingerprintSchema,
  revisionSchema,
  platformIdSchema,
  translateDefinitionRuleFailures,
  translateDefinitionSchemaError,
  recordTypeIdSchema,
  fieldIdSchema,
  type DefinitionCompilationOutput,
  type DefinitionResolutionSnapshot,
  type SessionContext,
  type ConditionNode,
  type ModuleSourceDocument,
  type ModuleField,
  type DefinitionValidationResult,
  type DefinitionValidationLocation,
  type DefinitionValidationTranslationContext,
  type DefinitionRuleFailure,
  type QueryId,
  type RecordTypeId,
  type Fingerprint,
  type ModuleRootId,
  type OrganizationId,
  type PlatformId,
  type Revision,
} from "../schema";
import { z } from "zod";
import { fingerprintCanonicalValue } from "./canonical-json-definition";
import type { PlatformPermissionSource } from "../access/platform-permissions";
import { DefinitionCompilationError } from "./compilation-error";
import { definitionSemanticRules, validateDefinitionSource } from "./validation";
import {
  type SourceIdentityAssignments,
  type ModuleSourceQuery,
  type ModuleOutput,
  refuse,
  type DefinitionPublicationCandidate,
  type DefinitionPublicationReader,
  type DefinitionPublicationCatalogue,
} from "./definition-publication-contracts";
import {
  type ResolvedDependencies,
  resolveDependencies,
  assertNoCycle,
  buildResolution,
} from "./definition-dependency-resolution";
import {
  type CompiledModuleCandidate,
  compileModuleCandidate,
  validateCandidate,
} from "./definition-publication-compilation";

export type ModuleQueryFilterParameterType =
  "text" | "number" | "decimal_number" | "money" | "boolean" | "date" | "date_time";

export type ModuleQueryFilterDraftContext = Readonly<{
  organizationId: OrganizationId;
  rootId: ModuleRootId;
  definitionKey: string;
  draftRevision: Revision;
  savedSourceFingerprint: Fingerprint;
  resolutionFingerprint: Fingerprint;
  operandBindingFingerprint: Fingerprint;
  query: Readonly<{
    alias: string;
    key: string;
    queryId: QueryId;
    recordAlias: string;
    recordKey: string;
    recordTypeId: RecordTypeId;
  }>;
  fields: readonly Readonly<{
    sourceAlias: string;
    sourceKey: string;
    field: ModuleField;
  }>[];
  parameters: readonly Readonly<{ key: string; type: ModuleQueryFilterParameterType }>[];
  filter: ConditionNode | null;
}>;

type ModuleQueryFilterOperandBinding = Pick<
  ModuleQueryFilterDraftContext,
  | "organizationId"
  | "rootId"
  | "definitionKey"
  | "draftRevision"
  | "savedSourceFingerprint"
  | "resolutionFingerprint"
  | "query"
  | "fields"
  | "parameters"
>;

export const fingerprintModuleQueryFilterOperandBinding = (
  binding: ModuleQueryFilterOperandBinding,
): Fingerprint =>
  fingerprintCanonicalValue({
    domain: "vortex.module_query_filter_operand_binding.v1",
    organizationId: binding.organizationId,
    rootId: binding.rootId,
    definitionKey: binding.definitionKey,
    draftRevision: binding.draftRevision,
    savedSourceFingerprint: binding.savedSourceFingerprint,
    resolutionFingerprint: binding.resolutionFingerprint,
    query: {
      alias: binding.query.alias,
      key: binding.query.key,
      queryId: binding.query.queryId,
    },
    record: {
      alias: binding.query.recordAlias,
      key: binding.query.recordKey,
      recordTypeId: binding.query.recordTypeId,
    },
    fields: binding.fields,
    parameters: binding.parameters,
  });

export type ModuleQueryFilterQueryChoice = Readonly<{
  alias: string;
  key: string;
  label?: string;
  eligible: boolean;
  reason?:
    "query_target_unsupported" | "operand_context_unsupported" | "retained_filter_unsupported";
}>;

export type ModuleQueryFilterDraftResult =
  | Readonly<{
      kind: "available";
      queryChoices: readonly ModuleQueryFilterQueryChoice[];
      selected?: ModuleQueryFilterDraftContext;
    }>
  | Readonly<{ kind: "validation_failed"; validation: DefinitionValidationResult }>
  | Readonly<{
      kind: "unsupported_context";
      reason:
        "query_target_unsupported" | "operand_context_unsupported" | "retained_filter_unsupported";
    }>;

export type ModuleQueryFilterValidationResult =
  | Readonly<{
      kind: "validated";
      source: ModuleSourceDocument;
      sourceFingerprint: Fingerprint;
      context: ModuleQueryFilterDraftContext;
      noChange: boolean;
    }>
  | Readonly<{ kind: "validation_failed"; validation: DefinitionValidationResult }>
  | Readonly<{
      kind: "unsupported_context";
      reason:
        "query_target_unsupported" | "operand_context_unsupported" | "retained_filter_unsupported";
    }>;

/** One current Application draft compiled at its exact revision, for exact-draft preview. */

export const moduleQueryFilterReadCommandSchema = z
  .object({
    rootId: platformIdSchema,
    expectedDraftRevision: revisionSchema,
    expectedSavedSourceFingerprint: fingerprintSchema,
    queryAlias: z.string().min(1).max(160).optional(),
  })
  .strict();

export const moduleQueryFilterValidationCommandSchema = z
  .object({
    rootId: platformIdSchema,
    expectedDraftRevision: revisionSchema,
    expectedSavedSourceFingerprint: fingerprintSchema,
    expectedResolutionFingerprint: fingerprintSchema,
    expectedOperandBindingFingerprint: fingerprintSchema,
    queryAlias: z.string().min(1).max(160),
    filter: z.union([z.null(), sourceConditionSchema]),
  })
  .strict();

const moduleQueryFieldTypes = new Set<ModuleField["type"]>([
  "text",
  "long_text",
  "whole_number",
  "yes_no",
  "date",
  "date_time",
]);
const isModuleQueryFilterParameterType = (value: string): value is ModuleQueryFilterParameterType =>
  value === "text" ||
  value === "number" ||
  value === "decimal_number" ||
  value === "money" ||
  value === "boolean" ||
  value === "date" ||
  value === "date_time";

const moduleValidationRoot = (source: ModuleSourceDocument): DefinitionValidationLocation => ({
  documentKind: "module",
  documentKey: source.key,
  segments: [{ kind: "module", key: source.key }],
});

const moduleValidationPathMap = (
  source: ModuleSourceDocument,
): DefinitionValidationTranslationContext["pathMap"] => {
  const rootLocation = moduleValidationRoot(source);
  const pathMap: NonNullable<DefinitionValidationTranslationContext["pathMap"]> = [];
  source.body.record_types.forEach((record, recordIndex) => {
    const recordLocation: DefinitionValidationLocation = {
      ...rootLocation,
      segments: [...rootLocation.segments, { kind: "record_type", key: record.key }],
    };
    pathMap.push({ sourcePath: ["body", "record_types", recordIndex], location: recordLocation });
    record.fields.forEach((field, fieldIndex) => {
      pathMap.push({
        sourcePath: ["body", "record_types", recordIndex, "fields", fieldIndex],
        location: {
          ...recordLocation,
          segments: [...recordLocation.segments, { kind: "field", key: field.key }],
        },
      });
    });
  });
  source.body.queries.forEach((query, queryIndex) => {
    pathMap.push({
      sourcePath: ["body", "queries", queryIndex],
      location: {
        ...rootLocation,
        segments: [...rootLocation.segments, { kind: "query", key: query.key }],
      },
    });
  });
  return pathMap;
};

export const moduleValidationTranslationContext = (
  source: ModuleSourceDocument,
  correlationId: string,
): DefinitionValidationTranslationContext => ({
  correlationId,
  rootLocation: moduleValidationRoot(source),
  pathMap: moduleValidationPathMap(source),
});

export const moduleValidationFailure = (
  error: DefinitionCompilationError,
  source: ModuleSourceDocument,
  correlationId: string,
): DefinitionValidationResult =>
  translateDefinitionRuleFailures(
    [
      {
        ruleCode: error.ruleCode,
        family: error.family,
        ...(error.location === undefined ? {} : { location: error.location }),
      } satisfies DefinitionRuleFailure,
    ],
    { correlationId, rootLocation: moduleValidationRoot(source) },
  );

const sameIdentifier = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

export const currentOwnedIdentity = (
  identities: SourceIdentityAssignments,
  definitionKey: string,
  kind: "query" | "record_type" | "field" | "flow" | "rule_node",
  scope: string,
  componentOwner: string,
  aliases: readonly string[],
): string | undefined => {
  const requestedAliases = [...new Set(aliases)];
  const found = requestedAliases.map((alias) => {
    const matches = identities.filter(
      (identity) =>
        identity.definitionKey === definitionKey &&
        identity.kind === kind &&
        identity.scope === scope &&
        identity.componentOwner === componentOwner &&
        identity.alias === alias,
    );
    return matches.length === 1 ? matches[0]!.identifier : undefined;
  });
  if (found.length === 0 || found.some((identifier) => identifier === undefined)) return undefined;
  const identifier = found[0];
  return identifier !== undefined && found.every((value) => value === identifier)
    ? identifier
    : undefined;
};

const conditionUsesOnlyCurrentOperands = (
  condition: ConditionNode | null,
  fields: readonly ModuleQueryFilterDraftContext["fields"][number][],
  parameters: readonly ModuleQueryFilterDraftContext["parameters"][number][],
): boolean => {
  if (condition === null) return true;
  const fieldIds = new Set(fields.map((entry) => entry.field.fieldId.toLowerCase()));
  const parameterKeys = new Set(parameters.map((entry) => entry.key));
  const visit = (node: ConditionNode): boolean => {
    if (node.kind === "not") return visit(node.condition);
    if (node.kind === "all" || node.kind === "any") return node.conditions.every(visit);
    if (node.kind !== "comparison") return false;
    const allowed = (operand: Extract<ConditionNode, { kind: "comparison" }>["left"]): boolean =>
      operand.source === "value" ||
      (operand.source === "field" && fieldIds.has(operand.fieldId.toLowerCase())) ||
      (operand.source === "parameter" && parameterKeys.has(operand.key));
    return allowed(node.left) && (node.right === undefined || allowed(node.right));
  };
  return visit(condition);
};

type EligibleModuleQuery = Readonly<{
  choice: ModuleQueryFilterQueryChoice;
  context?: ModuleQueryFilterDraftContext;
  source: ModuleSourceQuery;
}>;

export const moduleQueryChoices = (
  candidate: DefinitionPublicationCandidate,
  resolution: DefinitionResolutionSnapshot,
  output: ModuleOutput,
): readonly EligibleModuleQuery[] => {
  if (candidate.draft.kind !== "module" || candidate.draft.source.kind !== "module")
    return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  const parsedModuleRootId = moduleRootIdSchema.safeParse(candidate.draft.rootId);
  if (!parsedModuleRootId.success) return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  const source = candidate.draft.source;
  const moduleOutput = output.canonical;
  return source.body.queries.map((query): EligibleModuleQuery => {
    const queryChoiceBase = {
      alias: query.id,
      key: query.key,
      ...(query.label === undefined ? {} : { label: query.label }),
    };
    const queryIdentity = currentOwnedIdentity(
      resolution.identities,
      source.key,
      "query",
      "content",
      query.id,
      [query.id, query.key],
    );
    const parsedQueryId =
      queryIdentity === undefined ? undefined : queryIdSchema.safeParse(queryIdentity);
    const compiledQueries = moduleOutput.content.queries.filter(
      (entry) =>
        entry.key === query.key &&
        parsedQueryId?.success === true &&
        entry.queryId === parsedQueryId.data,
    );
    if (parsedQueryId?.success !== true || compiledQueries.length !== 1)
      return {
        source: query,
        choice: { ...queryChoiceBase, eligible: false, reason: "query_target_unsupported" },
      };
    if (query.record_type.includes(":"))
      return {
        source: query,
        choice: { ...queryChoiceBase, eligible: false, reason: "query_target_unsupported" },
      };
    const records = source.body.record_types.filter((record) => record.key === query.record_type);
    const compiledQuery = compiledQueries[0]!;
    if (
      records.length !== 1 ||
      compiledQuery.recordType.state !== "resolved" ||
      !sameIdentifier(compiledQuery.recordType.moduleRootId, parsedModuleRootId.data)
    )
      return {
        source: query,
        choice: { ...queryChoiceBase, eligible: false, reason: "query_target_unsupported" },
      };
    const record = records[0]!;
    const recordIdentity = currentOwnedIdentity(
      resolution.identities,
      source.key,
      "record_type",
      "content",
      record.id,
      [record.id, record.key],
    );
    const parsedRecordTypeId =
      recordIdentity === undefined ? undefined : recordTypeIdSchema.safeParse(recordIdentity);
    const compiledRecords = moduleOutput.content.recordTypes.filter(
      (entry) =>
        parsedRecordTypeId?.success === true && entry.recordTypeId === parsedRecordTypeId.data,
    );
    if (
      parsedRecordTypeId?.success !== true ||
      compiledRecords.length !== 1 ||
      compiledQuery.recordType.recordTypeId !== parsedRecordTypeId.data
    )
      return {
        source: query,
        choice: { ...queryChoiceBase, eligible: false, reason: "query_target_unsupported" },
      };

    const fields: ModuleQueryFilterDraftContext["fields"][number][] = [];
    const compiledRecord = compiledRecords[0]!;
    for (const sourceField of record.fields) {
      const identity = currentOwnedIdentity(
        resolution.identities,
        source.key,
        "field",
        `record:${record.key}`,
        sourceField.id,
        [sourceField.id, sourceField.key],
      );
      const parsedFieldId = identity === undefined ? undefined : fieldIdSchema.safeParse(identity);
      const compiledFields = compiledRecord.fields.filter(
        (field) => parsedFieldId?.success === true && field.fieldId === parsedFieldId.data,
      );
      const field = compiledFields[0];
      if (parsedFieldId?.success !== true || compiledFields.length !== 1 || field === undefined)
        continue;
      if (!moduleQueryFieldTypes.has(field.type) || !field.filterable) continue;
      fields.push({ sourceAlias: sourceField.id, sourceKey: sourceField.key, field });
    }
    const parameters = query.inputs.flatMap((input) =>
      isModuleQueryFilterParameterType(input.type) ? [{ key: input.key, type: input.type }] : [],
    );
    const parameterKeys = parameters.map((input) => input.key);
    if (
      fields.length === 0 ||
      parameters.length !== query.inputs.length ||
      new Set(parameterKeys).size !== parameterKeys.length
    )
      return {
        source: query,
        choice: { ...queryChoiceBase, eligible: false, reason: "operand_context_unsupported" },
      };

    let filter: ConditionNode | null = null;
    if (compiledQuery.filter !== undefined && compiledQuery.filter !== null) {
      const filterParsed = conditionNodeSchema.safeParse(compiledQuery.filter);
      if (!filterParsed.success)
        return {
          source: query,
          choice: { ...queryChoiceBase, eligible: false, reason: "retained_filter_unsupported" },
        };
      filter = filterParsed.data;
    }
    if (!conditionUsesOnlyCurrentOperands(filter, fields, parameters))
      return {
        source: query,
        choice: { ...queryChoiceBase, eligible: false, reason: "retained_filter_unsupported" },
      };
    const operandBinding = {
      organizationId: candidate.draft.organizationId,
      rootId: parsedModuleRootId.data,
      definitionKey: source.key,
      draftRevision: candidate.draft.draftRevision,
      savedSourceFingerprint: candidate.draft.sourceFingerprint,
      resolutionFingerprint: output.resolutionFingerprint,
      query: {
        alias: query.id,
        key: query.key,
        queryId: parsedQueryId.data,
        recordAlias: record.id,
        recordKey: record.key,
        recordTypeId: parsedRecordTypeId.data,
      },
      fields,
      parameters,
    };
    const operandBindingFingerprint = fingerprintModuleQueryFilterOperandBinding(operandBinding);
    const context: ModuleQueryFilterDraftContext = {
      organizationId: operandBinding.organizationId,
      rootId: operandBinding.rootId,
      definitionKey: operandBinding.definitionKey,
      draftRevision: operandBinding.draftRevision,
      savedSourceFingerprint: operandBinding.savedSourceFingerprint,
      resolutionFingerprint: operandBinding.resolutionFingerprint,
      operandBindingFingerprint,
      query: operandBinding.query,
      fields: operandBinding.fields,
      parameters: operandBinding.parameters,
      filter,
    };
    return { source: query, context, choice: { ...queryChoiceBase, eligible: true } };
  });
};

export const definitionModuleReferenceFailures = (
  request: z.output<typeof moduleCompilationRequestSchema>,
  output: ModuleOutput,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
  permissions: PlatformPermissionSource,
): readonly DefinitionRuleFailure[] => {
  const rule = definitionSemanticRules.find(
    (entry) => entry.ruleId === "vortex.definition.module_references",
  );
  if (rule === undefined) return refuse("DEFINITION_COMPILATION_REFUSED");
  return rule.run({ permissions, requests: [request], outputs: [output], dependencyOutputs });
};

export type CurrentModuleQueryFilterState = Readonly<{
  candidate: DefinitionPublicationCandidate;
  dependencies: ResolvedDependencies;
  resolution: DefinitionResolutionSnapshot;
  compiled: CompiledModuleCandidate;
  eligibleQueries: readonly EligibleModuleQuery[];
}>;

export const moduleValidationFromFailures = (
  failures: readonly DefinitionRuleFailure[],
  source: ModuleSourceDocument,
  correlationId: string,
): DefinitionValidationResult =>
  translateDefinitionRuleFailures(failures, {
    correlationId,
    rootLocation: moduleValidationRoot(source),
  });

export const compileCurrentModuleQueryFilterState = async (
  context: SessionContext,
  reader: DefinitionPublicationReader,
  catalogue: DefinitionPublicationCatalogue,
  command: Readonly<{
    rootId: PlatformId;
    expectedDraftRevision: Revision;
    expectedSavedSourceFingerprint: Fingerprint;
  }>,
): Promise<
  | Readonly<{ kind: "available"; state: CurrentModuleQueryFilterState }>
  | Readonly<{ kind: "validation_failed"; validation: DefinitionValidationResult }>
> => {
  const candidate = validateCandidate(context, await reader.readCandidate(command.rootId), {
    rootId: command.rootId,
    expectedDraftRevision: command.expectedDraftRevision,
  });
  if (candidate.draft.kind !== "module" || candidate.draft.source.kind !== "module")
    refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  if (candidate.draft.sourceFingerprint !== command.expectedSavedSourceFingerprint)
    refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  const source = moduleSourceDocumentSchema.safeParse(candidate.draft.source);
  if (!source.success)
    return {
      kind: "validation_failed",
      validation: translateDefinitionSchemaError(
        source.error,
        moduleValidationTranslationContext(candidate.draft.source, context.correlationId),
      ),
    };
  const shapeValidation = validateDefinitionSource(source.data, catalogue.permissions);
  if (!shapeValidation.valid)
    return {
      kind: "validation_failed",
      validation: moduleValidationFromFailures(
        shapeValidation.failures,
        source.data,
        context.correlationId,
      ),
    };
  try {
    const dependencies = await resolveDependencies(reader, catalogue, candidate);
    await assertNoCycle(reader, candidate, dependencies.modules);
    const ownVersion =
      candidate.historyEvidence.latestRelease?.publication.releaseVersion ?? "1.0.0";
    const resolution = buildResolution(candidate, dependencies, ownVersion);
    if (resolution.contractVersion !== "3.0.0") return refuse("DEFINITION_COMPILATION_REFUSED");
    const compiled = compileModuleCandidate(
      candidate,
      dependencies,
      resolution,
      catalogue.permissions,
    );
    const moduleReferenceFailures = definitionModuleReferenceFailures(
      compiled.request,
      compiled.output,
      compiled.dependencyOutputs,
      catalogue.permissions,
    );
    if (moduleReferenceFailures.length > 0)
      return {
        kind: "validation_failed",
        validation: moduleValidationFromFailures(
          moduleReferenceFailures,
          source.data,
          context.correlationId,
        ),
      };
    return {
      kind: "available",
      state: {
        candidate,
        dependencies,
        resolution,
        compiled,
        eligibleQueries: moduleQueryChoices(candidate, resolution, compiled.output),
      },
    };
  } catch (error) {
    if (!(error instanceof DefinitionCompilationError)) throw error;
    return {
      kind: "validation_failed",
      validation: moduleValidationFailure(error, source.data, context.correlationId),
    };
  }
};
