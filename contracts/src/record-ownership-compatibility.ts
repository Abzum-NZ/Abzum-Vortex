import { z } from "zod";

/** Current record-ownership terminology. Compiled definitions and the runtime use these values. */
export const recordOwnershipModeSchema = z.enum([
  "none",
  "organization_account",
  "group",
  "inherited",
]);

/**
 * Authored Module source values. The source format spells this one value
 * `organisation_account`, matching its other authored spellings.
 */
export const moduleSourceRecordOwnershipModeSchema = z.enum([
  "none",
  "organisation_account",
  "group",
  "inherited",
]);

export const readModuleSourceRecordOwnershipMode = (
  candidate: unknown,
): z.infer<typeof recordOwnershipModeSchema> => {
  const mode = moduleSourceRecordOwnershipModeSchema.parse(candidate);
  return mode === "organisation_account" ? "organization_account" : mode;
};

export type RecordOwnershipMode = z.infer<typeof recordOwnershipModeSchema>;
export type ModuleSourceRecordOwnershipMode = z.infer<typeof moduleSourceRecordOwnershipModeSchema>;
