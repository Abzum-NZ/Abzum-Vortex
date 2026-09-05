import { z } from "zod";

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

export type RecordOwnershipMode = z.infer<typeof recordOwnershipModeSchema>;
export type ModuleSourceRecordOwnershipModeV1 = z.infer<
  typeof moduleSourceRecordOwnershipModeV1Schema
>;
export type ModuleRecordOwnershipModeV1 = z.infer<typeof moduleRecordOwnershipModeV1Schema>;
