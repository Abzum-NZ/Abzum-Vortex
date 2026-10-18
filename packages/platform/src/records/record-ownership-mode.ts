import { z } from "zod";

/**
 * Record-ownership terminology, one spelling in the authored source and in the compiled
 * definition: what a Module authors is exactly what the compiler emits.
 */
export const recordOwnershipModeSchema = z.enum([
  "none",
  "organization_account",
  "group",
  "inherited",
]);

export type RecordOwnershipMode = z.infer<typeof recordOwnershipModeSchema>;
