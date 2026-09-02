import { z } from "zod";
import { correlationIdSchema } from "./common";
import { builderKeySchema, namespacedKeySchema } from "./identifiers";

export const definitionValidationCatalogueVersion = "1.0.0" as const;

export const definitionDocumentKindSchema = z.enum(["module", "application", "connection_type"]);

export const definitionLocationSegmentKindSchema = z.enum([
  "document",
  "module",
  "application",
  "record_type",
  "field",
  "relationship",
  "action",
  "rule",
  "event",
  "page",
  "block",
  "workflow",
  "workflow_node",
  "pipeline",
  "query",
  "role",
  "connection",
  "interface",
  "setting",
]);

const displayableDefinitionKeySchema = z.union([builderKeySchema, namespacedKeySchema]);

export const definitionValidationLocationSchema = z
  .object({
    documentKind: definitionDocumentKindSchema,
    documentKey: namespacedKeySchema,
    segments: z
      .array(
        z
          .object({
            kind: definitionLocationSegmentKindSchema,
            key: displayableDefinitionKeySchema,
          })
          .strict(),
      )
      .max(12),
  })
  .strict();

export const definitionValidationErrorCodes = [
  "definition_required_value",
  "definition_invalid_value",
  "definition_unsupported_choice",
  "definition_unknown_property",
  "definition_too_few_items",
  "definition_too_many_items",
  "definition_duplicate_key",
  "definition_broken_reference",
  "definition_unresolved_reference",
  "definition_scope_conflict",
  "definition_incompatible_version",
  "definition_dependency_cycle",
  "definition_unsafe_content",
  "definition_incompatible_change",
  "definition_validation_failed",
] as const;

export const definitionValidationErrorCodeSchema = z.enum(definitionValidationErrorCodes);

export const definitionValidationCatalogueEntrySchema = z
  .object({
    order: z.number().int().positive(),
    message: z.string().min(1).max(300),
    guidance: z.string().min(1).max(500),
  })
  .strict();

export const definitionValidationCatalogueSchema = z.record(
  definitionValidationErrorCodeSchema,
  definitionValidationCatalogueEntrySchema,
);

export type DefinitionValidationCatalogueEntry = z.infer<
  typeof definitionValidationCatalogueEntrySchema
>;
export type DefinitionValidationCatalogue = z.infer<typeof definitionValidationCatalogueSchema>;

const definitionValidationErrorCatalogueSource = {
  definition_required_value: {
    order: 10,
    message: "A required value is missing.",
    guidance: "Provide the required value and validate the definition again.",
  },
  definition_invalid_value: {
    order: 20,
    message: "A value is not valid for this definition.",
    guidance: "Check the value type and format, then validate the definition again.",
  },
  definition_unsupported_choice: {
    order: 30,
    message: "A selected value is not supported.",
    guidance: "Choose one of the values supported by the current contract version.",
  },
  definition_unknown_property: {
    order: 40,
    message: "The definition contains an unknown property.",
    guidance: "Remove the property or use one supported by the current contract version.",
  },
  definition_too_few_items: {
    order: 50,
    message: "The definition does not contain enough items.",
    guidance: "Add the required number of items and validate the definition again.",
  },
  definition_too_many_items: {
    order: 60,
    message: "The definition contains too many items.",
    guidance: "Remove excess items and validate the definition again.",
  },
  definition_duplicate_key: {
    order: 70,
    message: "A key is used more than once in the same scope.",
    guidance: "Give every item in that scope a unique key.",
  },
  definition_broken_reference: {
    order: 80,
    message: "A reference does not match its target.",
    guidance: "Update the reference so it points to a compatible target.",
  },
  definition_unresolved_reference: {
    order: 90,
    message: "A referenced definition could not be found.",
    guidance: "Add the referenced definition or correct the referenced key.",
  },
  definition_scope_conflict: {
    order: 100,
    message: "A definition is used outside its allowed scope.",
    guidance: "Move the definition or reference into a compatible scope.",
  },
  definition_incompatible_version: {
    order: 110,
    message: "A referenced version is not compatible.",
    guidance: "Use a compatible version or update the dependent definition.",
  },
  definition_dependency_cycle: {
    order: 120,
    message: "The definition contains a dependency cycle.",
    guidance: "Remove one dependency so the definitions can be evaluated in order.",
  },
  definition_unsafe_content: {
    order: 130,
    message: "The definition contains content that cannot be published safely.",
    guidance: "Remove the unsafe content and use an approved reference where required.",
  },
  definition_incompatible_change: {
    order: 140,
    message: "The definition change is not compatible with its published contract.",
    guidance: "Make a compatible change or publish it through the required version process.",
  },
  definition_validation_failed: {
    order: 1_000,
    message: "The definition could not be validated.",
    guidance: "Review the definition and use the correlation identifier if support is needed.",
  },
} as const satisfies Record<
  (typeof definitionValidationErrorCodes)[number],
  DefinitionValidationCatalogueEntry
>;

const parsedDefinitionValidationErrorCatalogue = definitionValidationCatalogueSchema.parse(
  definitionValidationErrorCatalogueSource,
);
for (const entry of Object.values(parsedDefinitionValidationErrorCatalogue)) Object.freeze(entry);

export const definitionValidationErrorCatalogue: Readonly<
  Record<DefinitionValidationErrorCode, Readonly<DefinitionValidationCatalogueEntry>>
> = Object.freeze(parsedDefinitionValidationErrorCatalogue);

export const publicDefinitionValidationErrorSchema = z
  .object({
    catalogueVersion: z.literal(definitionValidationCatalogueVersion),
    code: definitionValidationErrorCodeSchema,
    message: z.string().min(1).max(300),
    guidance: z.string().min(1).max(500),
    correlationId: correlationIdSchema,
    location: definitionValidationLocationSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const catalogueEntry = definitionValidationErrorCatalogue[value.code];
    if (value.message !== catalogueEntry.message || value.guidance !== catalogueEntry.guidance) {
      context.addIssue({
        code: "custom",
        message: "Public validation text must come from the versioned catalogue",
      });
    }
  });

export const definitionValidationResultSchema = z
  .object({
    catalogueVersion: z.literal(definitionValidationCatalogueVersion),
    correlationId: correlationIdSchema,
    errors: z.array(publicDefinitionValidationErrorSchema).min(1).max(200),
  })
  .strict()
  .superRefine((value, context) => {
    value.errors.forEach((error, index) => {
      if (error.correlationId !== value.correlationId) {
        context.addIssue({
          code: "custom",
          path: ["errors", index, "correlationId"],
          message: "Every error must use the result correlation identifier",
        });
      }
    });
  });

export const definitionRuleFailureFamilySchema = z.enum([
  "required_value",
  "invalid_value",
  "unsupported_choice",
  "unknown_property",
  "too_few_items",
  "too_many_items",
  "duplicate_key",
  "broken_reference",
  "unresolved_reference",
  "scope_conflict",
  "incompatible_version",
  "dependency_cycle",
  "unsafe_content",
  "incompatible_change",
]);

export const definitionRuleFailureSchema = z
  .object({
    ruleCode: namespacedKeySchema,
    family: definitionRuleFailureFamilySchema,
    location: definitionValidationLocationSchema.optional(),
  })
  .strict();

const rawIssuePathSchema = z.array(z.union([z.string(), z.number().int().nonnegative()])).max(50);

export const definitionValidationPathMapEntrySchema = z
  .object({
    sourcePath: rawIssuePathSchema,
    location: definitionValidationLocationSchema,
  })
  .strict();

export const definitionValidationTranslationContextSchema = z
  .object({
    correlationId: correlationIdSchema,
    rootLocation: definitionValidationLocationSchema,
    pathMap: z.array(definitionValidationPathMapEntrySchema).max(500).default([]),
    requiredPaths: z.array(rawIssuePathSchema).max(500).default([]),
  })
  .strict();

export type DefinitionDocumentKind = z.infer<typeof definitionDocumentKindSchema>;
export type DefinitionValidationLocation = z.infer<typeof definitionValidationLocationSchema>;
export type DefinitionValidationErrorCode = z.infer<typeof definitionValidationErrorCodeSchema>;
export type PublicDefinitionValidationError = z.infer<typeof publicDefinitionValidationErrorSchema>;
export type DefinitionValidationResult = z.infer<typeof definitionValidationResultSchema>;
export type DefinitionRuleFailure = z.infer<typeof definitionRuleFailureSchema>;
export type DefinitionValidationTranslationContext = z.input<
  typeof definitionValidationTranslationContextSchema
>;

export type ProtectedValidationDiagnostic = Readonly<{
  correlationId: z.infer<typeof correlationIdSchema>;
  source: "schema" | "rule";
  detail: unknown;
}>;

export type ProtectedValidationDiagnosticSink = (diagnostic: ProtectedValidationDiagnostic) => void;

type RawIssue = Readonly<{
  code?: unknown;
  origin?: unknown;
  path?: unknown;
}>;

const failureCodeByFamily = {
  required_value: "definition_required_value",
  invalid_value: "definition_invalid_value",
  unsupported_choice: "definition_unsupported_choice",
  unknown_property: "definition_unknown_property",
  too_few_items: "definition_too_few_items",
  too_many_items: "definition_too_many_items",
  duplicate_key: "definition_duplicate_key",
  broken_reference: "definition_broken_reference",
  unresolved_reference: "definition_unresolved_reference",
  scope_conflict: "definition_scope_conflict",
  incompatible_version: "definition_incompatible_version",
  dependency_cycle: "definition_dependency_cycle",
  unsafe_content: "definition_unsafe_content",
  incompatible_change: "definition_incompatible_change",
} as const satisfies Record<
  z.infer<typeof definitionRuleFailureFamilySchema>,
  DefinitionValidationErrorCode
>;

function pathsEqual(left: readonly (string | number)[], right: readonly (string | number)[]) {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function isPathPrefix(prefix: readonly (string | number)[], path: readonly (string | number)[]) {
  return prefix.length <= path.length && prefix.every((part, index) => part === path[index]);
}

function normalizeIssuePath(path: unknown): (string | number)[] {
  if (!Array.isArray(path)) return [];
  return path.filter(
    (part): part is string | number =>
      typeof part === "string" || (typeof part === "number" && Number.isInteger(part) && part >= 0),
  );
}

function resolveLocation(
  path: readonly (string | number)[],
  context: z.output<typeof definitionValidationTranslationContextSchema>,
) {
  const match = context.pathMap
    .filter((entry) => isPathPrefix(entry.sourcePath, path))
    .sort((left, right) => right.sourcePath.length - left.sourcePath.length)[0];
  return match?.location ?? context.rootLocation;
}

function schemaIssueCode(
  issue: RawIssue,
  path: readonly (string | number)[],
  context: z.output<typeof definitionValidationTranslationContextSchema>,
): DefinitionValidationErrorCode {
  if (issue.code === "invalid_type") {
    return context.requiredPaths.some((requiredPath) => pathsEqual(requiredPath, path))
      ? "definition_required_value"
      : "definition_invalid_value";
  }
  if (issue.code === "invalid_value") return "definition_unsupported_choice";
  if (issue.code === "unrecognized_keys") return "definition_unknown_property";
  if (issue.code === "too_small") {
    return issue.origin === "array" || issue.origin === "set"
      ? "definition_too_few_items"
      : "definition_invalid_value";
  }
  if (issue.code === "too_big") {
    return issue.origin === "array" || issue.origin === "set"
      ? "definition_too_many_items"
      : "definition_invalid_value";
  }
  if (
    issue.code === "invalid_format" ||
    issue.code === "not_multiple_of" ||
    issue.code === "invalid_union" ||
    issue.code === "invalid_key" ||
    issue.code === "invalid_element" ||
    issue.code === "custom"
  ) {
    return "definition_invalid_value";
  }
  return "definition_validation_failed";
}

function makePublicError(
  code: DefinitionValidationErrorCode,
  correlationId: z.infer<typeof correlationIdSchema>,
  location?: DefinitionValidationLocation,
): PublicDefinitionValidationError {
  const entry = definitionValidationErrorCatalogue[code];
  return {
    catalogueVersion: definitionValidationCatalogueVersion,
    code,
    message: entry.message,
    guidance: entry.guidance,
    correlationId,
    ...(location ? { location } : {}),
  };
}

function locationSortKey(location: DefinitionValidationLocation | undefined) {
  if (!location) return "";
  return [
    location.documentKind,
    location.documentKey,
    ...location.segments.flatMap((segment) => [segment.kind, segment.key]),
  ].join("\u0000");
}

function finishResult(
  errors: readonly PublicDefinitionValidationError[],
  correlationId: z.infer<typeof correlationIdSchema>,
): DefinitionValidationResult {
  const deduplicated = new Map<string, PublicDefinitionValidationError>();
  for (const error of errors) {
    const key = `${error.code}\u0000${locationSortKey(error.location)}`;
    deduplicated.set(key, error);
  }
  const sorted = [...deduplicated.values()].sort((left, right) => {
    const leftLocation = locationSortKey(left.location);
    const rightLocation = locationSortKey(right.location);
    const locationOrder = leftLocation < rightLocation ? -1 : leftLocation > rightLocation ? 1 : 0;
    if (locationOrder !== 0) return locationOrder;
    return (
      definitionValidationErrorCatalogue[left.code].order -
      definitionValidationErrorCatalogue[right.code].order
    );
  });
  return definitionValidationResultSchema.parse({
    catalogueVersion: definitionValidationCatalogueVersion,
    correlationId,
    errors:
      sorted.length > 0 ? sorted : [makePublicError("definition_validation_failed", correlationId)],
  });
}

function emitDiagnostic(
  sink: ProtectedValidationDiagnosticSink | undefined,
  diagnostic: ProtectedValidationDiagnostic,
) {
  try {
    sink?.(diagnostic);
  } catch {
    // Diagnostic storage must never change the safe public result.
  }
}

function parseTranslationContextOrFallback(
  inputContext: DefinitionValidationTranslationContext,
):
  | { success: true; context: z.output<typeof definitionValidationTranslationContextSchema> }
  | { success: false; result: DefinitionValidationResult } {
  const parsed = definitionValidationTranslationContextSchema.safeParse(inputContext);
  if (parsed.success) return { success: true, context: parsed.data };
  const candidate = inputContext as unknown;
  const correlationCandidate =
    typeof candidate === "object" && candidate !== null && "correlationId" in candidate
      ? (candidate as { correlationId: unknown }).correlationId
      : undefined;
  const correlation = correlationIdSchema.safeParse(correlationCandidate);
  if (!correlation.success) {
    throw new Error("Definition validation requires a valid correlation identifier");
  }
  return {
    success: false,
    result: finishResult(
      [makePublicError("definition_validation_failed", correlation.data)],
      correlation.data,
    ),
  };
}

export function translateDefinitionSchemaError(
  error: z.ZodError,
  inputContext: DefinitionValidationTranslationContext,
  diagnosticSink?: ProtectedValidationDiagnosticSink,
): DefinitionValidationResult {
  const parsedContext = parseTranslationContextOrFallback(inputContext);
  if (!parsedContext.success) return parsedContext.result;
  const context = parsedContext.context;
  emitDiagnostic(diagnosticSink, {
    correlationId: context.correlationId,
    source: "schema",
    detail: error,
  });
  try {
    const errors = error.issues.map((issue) => {
      const path = normalizeIssuePath(issue.path);
      return makePublicError(
        schemaIssueCode(issue, path, context),
        context.correlationId,
        resolveLocation(path, context),
      );
    });
    return finishResult(errors, context.correlationId);
  } catch {
    return finishResult(
      [
        makePublicError(
          "definition_validation_failed",
          context.correlationId,
          context.rootLocation,
        ),
      ],
      context.correlationId,
    );
  }
}

export function translateDefinitionRuleFailures(
  inputFailures: readonly DefinitionRuleFailure[],
  inputContext: DefinitionValidationTranslationContext,
  diagnosticSink?: ProtectedValidationDiagnosticSink,
): DefinitionValidationResult {
  const parsedContext = parseTranslationContextOrFallback(inputContext);
  if (!parsedContext.success) return parsedContext.result;
  const context = parsedContext.context;
  emitDiagnostic(diagnosticSink, {
    correlationId: context.correlationId,
    source: "rule",
    detail: inputFailures,
  });
  const failures = z.array(definitionRuleFailureSchema).safeParse(inputFailures);
  if (!failures.success) {
    return finishResult(
      [
        makePublicError(
          "definition_validation_failed",
          context.correlationId,
          context.rootLocation,
        ),
      ],
      context.correlationId,
    );
  }
  return finishResult(
    failures.data.map((failure) =>
      makePublicError(
        failureCodeByFamily[failure.family],
        context.correlationId,
        failure.location ?? context.rootLocation,
      ),
    ),
    context.correlationId,
  );
}
