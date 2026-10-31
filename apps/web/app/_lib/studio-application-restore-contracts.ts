import { z } from "zod";
import {
  applicationRootIdSchema,
  fingerprintSchema,
  organizationIdSchema,
  revisionSchema,
} from "@vortex/platform/schema";

const studioApplicationRestoreSelectorSchema = z
  .object({
    organizationId: organizationIdSchema,
    rootId: applicationRootIdSchema,
    releaseRevision: revisionSchema,
  })
  .strict();

const studioApplicationRestoreExpectedSchema = z
  .object({
    draftRevision: revisionSchema.refine((revision) => revision < Number.MAX_SAFE_INTEGER),
    sourceFingerprint: fingerprintSchema,
    anchorReleaseRevision: revisionSchema,
  })
  .strict();

/** How the viewer may see one person: named, restricted by the directory permissions, or not readable right now. */
export type StudioPersonLabel =
  | Readonly<{ kind: "named"; name: string }>
  | Readonly<{ kind: "restricted" }>
  | Readonly<{ kind: "unavailable" }>;

export const studioApplicationRestoreCommandSchema = z
  .object({
    selector: studioApplicationRestoreSelectorSchema,
    expected: studioApplicationRestoreExpectedSchema,
    confirmed: z.literal(true),
  })
  .strict()
  .superRefine((command, refinement) => {
    if (command.selector.releaseRevision > command.expected.anchorReleaseRevision) {
      refinement.addIssue({
        code: "custom",
        path: ["selector", "releaseRevision"],
        message: "Restore target is beyond the shown publication anchor",
      });
    }
  });

export const studioApplicationRestoreCommandResultSchema = z.union([
  z
    .object({
      kind: z.literal("completed"),
      stateMayHaveChanged: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["refused", "superseded", "conflict", "temporarily_unavailable"]),
      stateMayHaveChanged: z.union([z.literal(false), z.literal("unknown")]),
    })
    .strict(),
]);

/** Why a restore did not run; `superseded`: the version predates the current definition contract. */
export type StudioApplicationRestoreFailure = Readonly<{
  kind: "refused" | "superseded" | "conflict" | "temporarily_unavailable";
}>;
export type StudioApplicationRestoreCommand = z.infer<typeof studioApplicationRestoreCommandSchema>;
export type StudioApplicationRestoreCommandResult = z.infer<
  typeof studioApplicationRestoreCommandResultSchema
>;
