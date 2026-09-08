import { z } from "zod";
import { moduleContentV2Schema, moduleDraftV2Schema } from "./module-contracts-v2";
import { moduleSourceContractVersionV3 } from "./module-source-contracts-v3";
import { ruleGraphSchema } from "./rule-graph-contracts";

export const moduleValidationContractVersionV3 = "3.0.0" as const;

/** A candidate pair, not an assertion that Definition can publish it yet. */
export const moduleContractVersionPairV3Schema = z
  .object({
    sourceContractVersion: z.literal(moduleSourceContractVersionV3),
    validationContractVersion: z.literal(moduleValidationContractVersionV3),
  })
  .strict();

export const moduleContentV3Schema = moduleContentV2Schema.extend({
  rules: z.array(ruleGraphSchema).max(100),
});

export const moduleDraftV3Schema = moduleDraftV2Schema.extend({
  content: moduleContentV3Schema,
});

export const moduleCanonicalDocumentV3Schema = z
  .object({
    validationContractVersion: z.literal(moduleValidationContractVersionV3),
    canonical: moduleDraftV3Schema,
  })
  .strict();

export type ModuleContractVersionPairV3 = z.infer<typeof moduleContractVersionPairV3Schema>;
export type ModuleContentV3 = z.infer<typeof moduleContentV3Schema>;
export type ModuleDraftV3 = z.infer<typeof moduleDraftV3Schema>;
export type ModuleCanonicalDocumentV3 = z.infer<typeof moduleCanonicalDocumentV3Schema>;
