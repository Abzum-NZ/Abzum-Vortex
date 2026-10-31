import { z } from "zod";
import {
  applicationRootIdSchema,
  fieldIdSchema,
  fingerprintSchema,
  organizationIdSchema,
  revisionSchema,
  storageContractIdSchema,
} from "../catalogue/identifiers";

const nonNilUuidSchema = z
  .uuid()
  .refine((value) => value !== "00000000-0000-0000-0000-000000000000", {
    message: "An index identity cannot be the nil UUID",
  });

/** An exact field index is either a uniqueness requirement or advisory performance. */
const indexPurposeSchema = z.enum(["uniqueness", "performance"]);

/** The live physical state of one exact field index. */
const indexObservedStateSchema = z.enum(["missing", "present", "invalid"]);

/**
 * Readiness of one exact field index of one exact storage contract and field.
 * `desiredDefinitionFingerprint` is the canonical sha256 of the exact index
 * definition the provisioner emits, so readiness answers the desired definition
 * rather than any index of the same name.
 */
const indexReadinessEntrySchema = z
  .object({
    indexContractId: nonNilUuidSchema,
    storageContractId: storageContractIdSchema,
    fieldId: fieldIdSchema,
    purpose: indexPurposeSchema,
    desiredDefinitionFingerprint: fingerprintSchema,
    observedState: indexObservedStateSchema,
    recordedObservedState: indexObservedStateSchema.nullable(),
    observedRevision: revisionSchema.nullable(),
    ready: z.boolean(),
  })
  .strict()
  .superRefine((entry, context) => {
    // `ready` is only meaningful for a physically present index; a caller must
    // never be able to read a missing or invalid observation as ready.
    if (entry.ready && entry.observedState !== "present")
      context.addIssue({
        code: "custom",
        path: ["ready"],
        message: "An index can only be ready while its observed state is present",
      });
  });

/**
 * The complete live index-readiness snapshot for one activating Application
 * installation. The snapshot is taken immediately after the Module activation
 * write and before that write is accepted, so it can only be trusted for the
 * exact organisation, Application release and binding set it names.
 */
export const indexReadinessSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
    indexes: z.array(indexReadinessEntrySchema).max(100_000),
    uniquenessReady: z.boolean(),
    performanceAdvisory: z.literal(true),
  })
  .strict()
  .superRefine((readiness, context) => {
    const requiredReady = readiness.indexes.every(
      (entry) => entry.purpose !== "uniqueness" || entry.ready,
    );
    if (readiness.uniquenessReady !== requiredReady)
      context.addIssue({
        code: "custom",
        path: ["uniquenessReady"],
        message: "uniquenessReady must reflect every uniqueness entry's readiness",
      });
  });
