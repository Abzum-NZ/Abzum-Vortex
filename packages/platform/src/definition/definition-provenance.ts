import { z } from "zod";
import { namespacedKeySchema } from "./identifiers";

/**
 * Where one canonical value came from. It lives apart from the compilation contracts so the
 * authored flow source contract can share it without importing the source documents that import
 * that contract.
 */
const definitionPathSchema = z
  .array(z.union([z.string(), z.number().int().nonnegative()]))
  .max(100);
export const definitionProvenanceEntrySchema = z
  .object({
    canonicalPath: definitionPathSchema,
    origin: z.enum(["source", "resolved", "fixed_default", "system_metadata"]),
    sourcePath: definitionPathSchema.optional(),
    ruleCode: namespacedKeySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const tracesSource = value.origin === "source" || value.origin === "resolved";
    if (tracesSource !== (value.sourcePath !== undefined))
      context.addIssue({
        code: "custom",
        path: ["sourcePath"],
        message:
          "Source and resolved provenance require a source path; defaults and system metadata do not",
      });
  });

export type DefinitionProvenanceEntry = z.infer<typeof definitionProvenanceEntrySchema>;
