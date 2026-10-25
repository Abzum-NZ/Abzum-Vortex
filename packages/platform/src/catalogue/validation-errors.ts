import { z } from "zod";
import { correlationIdSchema } from "./common";
import { builderKeySchema, namespacedKeySchema } from "./identifiers";
import { recordsTableFeatureRefusals } from "../definition/application-composition/records-table-features/index";
import { recordsTableFeatureRefusalCodes } from "../definition/application-composition/records-table-features/shared";
import { describeFailure } from "./runtime-primitives";

export const definitionValidationCatalogueVersion = "1.4.0" as const;

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
  "extension_point",
  "page",
  "block",
  "pipeline",
  "query",
  "role",
  "connection",
  "interface",
  "setting",
  "flow",
  "flow_node",
  "flow_edge",
  "flow_binding",
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
  ...recordsTableFeatureRefusalCodes,
  "definition_required_value",
  "definition_invalid_value",
  "definition_unsupported_choice",
  "definition_records_table_visible_columns",
  "definition_records_table_auto_size",
  "definition_query_binding",
  "definition_runtime_not_supported",
  "definition_query_binding_choice",
  "definition_form_field_dependency",
  "definition_unknown_property",
  "definition_too_few_items",
  "definition_too_many_items",
  "definition_sortable_field_limit",
  "definition_duplicate_key",
  "definition_broken_reference",
  "definition_unresolved_reference",
  "definition_scope_conflict",
  "definition_incompatible_version",
  "definition_dependency_cycle",
  "definition_unsafe_content",
  "definition_incompatible_change",
  "definition_more_errors",
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

/** The platform's own codes: every code except the grid feature refusals, whose definitions hold them. */
type PlatformDefinitionValidationErrorCode = Exclude<
  DefinitionValidationErrorCode,
  (typeof recordsTableFeatureRefusalCodes)[number]
>;
const platformDefinitionValidationErrorCodes = definitionValidationErrorCodes.filter(
  (code): code is PlatformDefinitionValidationErrorCode =>
    !(recordsTableFeatureRefusalCodes as readonly string[]).includes(code),
);

export const definitionValidationCatalogueSchema = z.record(
  z.enum(
    platformDefinitionValidationErrorCodes as [
      PlatformDefinitionValidationErrorCode,
      ...PlatformDefinitionValidationErrorCode[],
    ],
  ),
  definitionValidationCatalogueEntrySchema,
);

export type DefinitionValidationCatalogueEntry = z.infer<
  typeof definitionValidationCatalogueEntrySchema
>;

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
  definition_records_table_visible_columns: {
    order: 35,
    message: "Keep at least one column visible.",
    guidance: "Choose Visible by default for a column before publishing.",
  },
  definition_records_table_auto_size: {
    order: 35,
    message: "Auto-size needs a field to measure. Choose a field for the column.",
    guidance: "Choose the column's field, or turn Auto-size off.",
  },
  // A query binding refusal carries its own sentence (the input, the source and the types); the
  // catalogue message is what a reader without that sentence sees.
  definition_query_binding: {
    order: 39,
    message: "A query input of a block has no valid source.",
    guidance:
      "Open the block's Query inputs and choose a source of the input's type for each input.",
  },
  definition_runtime_not_supported: {
    order: 39,
    message: "This declaration has no runtime support yet.",
    guidance: "Remove the unsupported declaration before publishing.",
  },
  definition_query_binding_choice: {
    order: 39,
    message: "A fixed value is not one of the choices of its query input.",
    guidance: "Open the block's Query inputs and pick one of the choices the input now offers.",
  },
  // The sentence names the dependent field and the field it depends on.
  definition_form_field_dependency: {
    order: 39,
    message: "A form shows a field without the field its choices depend on.",
    guidance: "Add the field it depends on to the same form, or remove the dependent field.",
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
  definition_sortable_field_limit: {
    order: 65,
    message: "A record type may declare at most eight sortable fields.",
    guidance: "Choose up to eight sortable fields for this record type, then publish again.",
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
  definition_more_errors: {
    order: 900,
    message: "Additional validation errors were omitted.",
    guidance: "Resolve the displayed errors and validate the definition again.",
  },
  definition_validation_failed: {
    order: 1_000,
    message: "The definition could not be validated.",
    guidance: "Review the definition and use the correlation identifier if support is needed.",
  },
} as const satisfies Record<
  PlatformDefinitionValidationErrorCode,
  DefinitionValidationCatalogueEntry
>;

const parsedDefinitionValidationErrorCatalogue = definitionValidationCatalogueSchema.parse(
  definitionValidationErrorCatalogueSource,
);
for (const entry of Object.values(parsedDefinitionValidationErrorCatalogue)) Object.freeze(entry);

/**
 * The platform's own validation sentences. A grid feature's refusal sentence lives in the feature's
 * definition; `definitionValidationMessage` reads either.
 */
export const definitionValidationErrorCatalogue: Readonly<
  Record<PlatformDefinitionValidationErrorCode, Readonly<DefinitionValidationCatalogueEntry>>
> = Object.freeze(parsedDefinitionValidationErrorCatalogue);

/**
 * The catalogue entry of any definition validation code: the platform's own, or a grid feature's
 * refusal as its feature definition declares it.
 */
export const definitionValidationEntry = (
  code: DefinitionValidationErrorCode,
): Readonly<DefinitionValidationCatalogueEntry> => {
  if (Object.hasOwn(definitionValidationErrorCatalogue, code))
    return definitionValidationErrorCatalogue[code as PlatformDefinitionValidationErrorCode];
  const entry = recordsTableFeatureRefusals.find((candidate) => candidate.code === code);
  if (entry === undefined) throw new Error(`No validation sentence for ${code}`);
  return entry;
};

/** The business sentence of any definition validation code. */
export const definitionValidationMessage = (code: DefinitionValidationErrorCode): string =>
  definitionValidationEntry(code).message;

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
    const catalogueEntry = definitionValidationEntry(value.code);
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
  "more_errors",
]);

export const definitionRuleFailureSchema = z
  .object({
    ruleCode: namespacedKeySchema,
    family: definitionRuleFailureFamilySchema,
    /** A rule with its own business sentence names its catalogue code; others use the family's. */
    code: definitionValidationErrorCodeSchema.optional(),
    /** The rule's own business sentence for this failure, when it names the parts involved. */
    sentence: z.string().min(1).max(500).optional(),
    location: definitionValidationLocationSchema.optional(),
  })
  .strict();

const rawIssuePathSchema = z.array(z.union([z.string(), z.number().int().nonnegative()])).max(64);

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
    pathMap: z.array(definitionValidationPathMapEntrySchema).max(50_000).default([]),
    // One bounded source node can report several missing required properties.
    requiredPaths: z.array(rawIssuePathSchema).max(1_000_000).default([]),
  })
  .strict();

export type DefinitionValidationLocation = z.infer<typeof definitionValidationLocationSchema>;
export type DefinitionValidationErrorCode = z.infer<typeof definitionValidationErrorCodeSchema>;
export type PublicDefinitionValidationError = z.infer<typeof publicDefinitionValidationErrorSchema>;
export type DefinitionValidationResult = z.infer<typeof definitionValidationResultSchema>;
export type DefinitionRuleFailure = z.infer<typeof definitionRuleFailureSchema>;
export type DefinitionRuleFailureFamily = z.infer<typeof definitionRuleFailureFamilySchema>;
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
  message?: unknown;
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
  more_errors: "definition_more_errors",
} as const satisfies Record<
  z.infer<typeof definitionRuleFailureFamilySchema>,
  DefinitionValidationErrorCode
>;

function normalizeIssuePath(path: unknown): (string | number)[] {
  if (!Array.isArray(path)) return [];
  return path.filter(
    (part): part is string | number =>
      typeof part === "string" || (typeof part === "number" && Number.isInteger(part) && part >= 0),
  );
}

function resolveLocation(
  path: readonly (string | number)[],
  pathMap: ReadonlyMap<string, DefinitionValidationLocation>,
  rootLocation: DefinitionValidationLocation,
) {
  for (let length = path.length; length >= 0; length -= 1) {
    const match = pathMap.get(JSON.stringify(path.slice(0, length)));
    if (match) return match;
  }
  return rootLocation;
}

function schemaIssueCode(
  issue: RawIssue,
  path: readonly (string | number)[],
  requiredPaths: ReadonlySet<string>,
): DefinitionValidationErrorCode {
  if (
    issue.code === "custom" &&
    issue.message === "A record type may declare at most eight sortable fields"
  )
    return "definition_sortable_field_limit";
  if (issue.code === "invalid_type") {
    return requiredPaths.has(JSON.stringify(path))
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
  const entry = definitionValidationEntry(code);
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
  const alreadyTruncated = errors.some((error) => error.code === "definition_more_errors");
  const deduplicated = new Map<string, PublicDefinitionValidationError>();
  for (const error of errors) {
    if (error.code === "definition_more_errors") continue;
    const key = `${error.code}\u0000${locationSortKey(error.location)}`;
    deduplicated.set(key, error);
  }
  const sorted = [...deduplicated.values()].sort((left, right) => {
    const leftLocation = locationSortKey(left.location);
    const rightLocation = locationSortKey(right.location);
    const locationOrder = leftLocation < rightLocation ? -1 : leftLocation > rightLocation ? 1 : 0;
    if (locationOrder !== 0) return locationOrder;
    return definitionValidationEntry(left.code).order - definitionValidationEntry(right.code).order;
  });
  const truncated = alreadyTruncated || sorted.length > 200;
  return definitionValidationResultSchema.parse({
    catalogueVersion: definitionValidationCatalogueVersion,
    correlationId,
    errors: truncated
      ? [...sorted.slice(0, 199), makePublicError("definition_more_errors", correlationId)]
      : sorted.length > 0
        ? sorted
        : [makePublicError("definition_validation_failed", correlationId)],
  });
}

function emitDiagnostic(
  sink: ProtectedValidationDiagnosticSink | undefined,
  diagnostic: ProtectedValidationDiagnostic,
) {
  try {
    sink?.(diagnostic);
  } catch (error) {
    console.error(
      `[validation] diagnostic not stored VALIDATION_DIAGNOSTIC_SINK_FAILED: ${describeFailure(error)}`,
    );
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
    const pathMap = new Map<string, DefinitionValidationLocation>();
    for (const entry of context.pathMap) {
      const key = JSON.stringify(entry.sourcePath);
      if (!pathMap.has(key)) pathMap.set(key, entry.location);
    }
    const requiredPaths = new Set(context.requiredPaths.map((path) => JSON.stringify(path)));
    const errors = error.issues.map((issue) => {
      const path = normalizeIssuePath(issue.path);
      return makePublicError(
        schemaIssueCode(issue, path, requiredPaths),
        context.correlationId,
        resolveLocation(path, pathMap, context.rootLocation),
      );
    });
    if (errors.some((entry) => entry.code === "definition_sortable_field_limit"))
      console.error(
        `[definition] definition_sortable_field_limit ${context.correlationId}: a record type declares more than eight sortable fields`,
      );
    return finishResult(errors, context.correlationId);
  } catch (error) {
    console.error(
      `[definition] DEFINITION_VALIDATION_TRANSLATION_FAILED: ${describeFailure(error)}`,
    );
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
        failure.code ?? failureCodeByFamily[failure.family],
        context.correlationId,
        failure.location ?? context.rootLocation,
      ),
    ),
    context.correlationId,
  );
}
