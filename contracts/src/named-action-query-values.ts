import { z } from "zod";
import {
  builderKeySchema, fieldIdSchema, moduleRootIdSchema, organizationAccountIdSchema,
  queryIdSchema, recordIdSchema, recordTypeIdSchema, semanticVersionSchema,
} from "./identifiers";
import { normalizeExactDecimal } from "./exact-decimal";

/** A protected, complete Query reduction, available only to a named action's set-fields task. */
export const namedActionQueryValueSchema = z.object({
  kind: z.literal("protected_query_decimal_max_plus_quantum"),
  queryId: queryIdSchema,
  fieldId: fieldIdSchema,
  quantum: z.literal("0.000000000001"),
}).strict();

/** Authored identities are resolved within the action's owning Module, never supplied by a caller. */
export const sourceNamedActionQueryValueSchema = z.object({
  kind: z.literal("protected_query_decimal_max_plus_quantum"),
  query: builderKeySchema,
  field: builderKeySchema,
  quantum: z.literal("0.000000000001"),
}).strict();

export type NamedActionQueryValue = z.infer<typeof namedActionQueryValueSchema>;

const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** Private preparation proof; it never becomes a record projection or browser payload. */
export const preparedNamedActionQueryValueSchema = z.object({
  taskId: builderKeySchema,
  fieldId: fieldIdSchema,
  value: z.string().refine((value) => normalizeExactDecimal(value) === value),
  node: namedActionQueryValueSchema,
  source: z.object({
    moduleId: moduleRootIdSchema,
    moduleReleaseRevision: revisionSchema,
    moduleReleaseVersion: semanticVersionSchema,
    queryId: queryIdSchema,
    recordTypeId: recordTypeIdSchema,
    subjectRecordId: recordIdSchema,
    subjectRevision: revisionSchema,
    organizationAccountId: organizationAccountIdSchema,
    accessVersion: revisionSchema,
  }).strict(),
}).strict();
export type PreparedNamedActionQueryValue = z.infer<typeof preparedNamedActionQueryValueSchema>;
