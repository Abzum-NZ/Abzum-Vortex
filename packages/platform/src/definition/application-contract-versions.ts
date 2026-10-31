import { z } from "zod";
import { DefinitionError } from "./definition-error";

/**
 * The one current definition contract. Every definition kind accepts exactly this version, in its
 * source and in its validation output alike; `supabase/schemas/vortex_definition/accepted_contract_version.sql`
 * holds the same value for the database, and the guard compares the two.
 */
export const definitionContractVersion = "4.4.0" as const;

/** The source and validation pair every stored and authored definition carries. */
export const definitionContractVersionPairSchema = z
  .object({
    sourceContractVersion: z.literal(definitionContractVersion),
    validationContractVersion: z.literal(definitionContractVersion),
  })
  .strict();

/** Refuses any source and validation pair other than the one current definition contract. */
export const assertDefinitionContractPair = (
  sourceContractVersion: string,
  validationContractVersion: string,
): void => {
  if (sourceContractVersion !== definitionContractVersion)
    throw new DefinitionError("UNKNOWN_DEFINITION_CONTRACT_VERSION");
  if (validationContractVersion !== definitionContractVersion)
    throw new DefinitionError("UNKNOWN_DEFINITION_CONTRACT_VERSION");
};
