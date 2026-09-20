import { z } from "zod";
import { v5 as uuidV5 } from "uuid";
import { platformIdSchema, recordIdSchema, recordTypeIdSchema } from "./identifiers";

/** Current runtime terminology. Serialized Definition V1 contracts remain separate below. */
export const recordOwnershipModeSchema = z.enum([
  "none",
  "organization_account",
  "group",
  "inherited",
]);

/** Exact authored Definition V1 wire values. */
export const moduleSourceRecordOwnershipModeV1Schema = z.enum([
  "none",
  "organisation_account",
  "team",
  "inherited",
]);

/** Exact compiled Definition V1 wire values. */
export const moduleRecordOwnershipModeV1Schema = z.enum([
  "none",
  "organization_account",
  "team",
  "inherited",
]);

export const readModuleSourceRecordOwnershipModeV1 = (
  candidate: unknown,
): z.infer<typeof recordOwnershipModeSchema> => {
  const mode = moduleSourceRecordOwnershipModeV1Schema.parse(candidate);
  if (mode === "organisation_account") return "organization_account";
  return mode === "team" ? "group" : mode;
};

export const writeModuleRecordOwnershipModeV1 = (
  candidate: unknown,
): z.infer<typeof moduleRecordOwnershipModeV1Schema> => {
  const mode = recordOwnershipModeSchema.parse(candidate);
  return mode === "group" ? "team" : mode;
};

export const recordOwnershipTransferTargetKindSchema = z.enum(["organization_account", "group"]);

export const recordOwnershipTransferTargetDecisionSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("compatible") }).strict(),
  z
    .object({
      outcome: z.literal("refused_incompatible"),
      reason: z.enum(["target_kind_mismatch", "ownership_not_direct"]),
    })
    .strict(),
]);

/** Pure compatibility decision shared by preview and transfer orchestration. */
export const decideRecordOwnershipTransferTarget = (
  ownershipModeCandidate: unknown,
  targetKindCandidate: unknown,
): z.infer<typeof recordOwnershipTransferTargetDecisionSchema> => {
  const ownershipMode = recordOwnershipModeSchema.parse(ownershipModeCandidate);
  const targetKind = recordOwnershipTransferTargetKindSchema.parse(targetKindCandidate);
  if (ownershipMode === "none" || ownershipMode === "inherited")
    return { outcome: "refused_incompatible", reason: "ownership_not_direct" };
  return ownershipMode === targetKind
    ? { outcome: "compatible" }
    : { outcome: "refused_incompatible", reason: "target_kind_mismatch" };
};

/**
 * Fixed UUID-v5 namespace for retry-safe offboarding transfer commands.
 * It was derived once from the UUID URL namespace and the stable Vortex
 * offboarding-transfer URL; its serialized value is now the permanent contract.
 */
export const offboardingTransferCommandNamespace = "036eb24c-fed1-575f-b3b6-0a9a608e1942";

export const offboardingTransferCommandId = (
  batchIdCandidate: unknown,
  recordTypeIdCandidate: unknown,
  recordIdCandidate: unknown,
): z.infer<typeof platformIdSchema> => {
  const batchId = platformIdSchema.parse(batchIdCandidate).toLowerCase();
  const recordTypeId = recordTypeIdSchema.parse(recordTypeIdCandidate).toLowerCase();
  const recordId = recordIdSchema.parse(recordIdCandidate).toLowerCase();
  return platformIdSchema.parse(
    uuidV5(`${batchId}:${recordTypeId}:${recordId}`, offboardingTransferCommandNamespace),
  );
};

export type RecordOwnershipMode = z.infer<typeof recordOwnershipModeSchema>;
export type RecordOwnershipTransferTargetKind = z.infer<
  typeof recordOwnershipTransferTargetKindSchema
>;
export type RecordOwnershipTransferTargetDecision = z.infer<
  typeof recordOwnershipTransferTargetDecisionSchema
>;
export type ModuleSourceRecordOwnershipModeV1 = z.infer<
  typeof moduleSourceRecordOwnershipModeV1Schema
>;
export type ModuleRecordOwnershipModeV1 = z.infer<typeof moduleRecordOwnershipModeV1Schema>;
