import { z } from "zod";
import {
  moduleSourceBodyV2Schema,
  moduleSourceDocumentV2Schema,
} from "./module-source-contracts-v2";
import { sourceRuleGraphSchema } from "./rule-graph-source-contracts";

export const moduleSourceContractVersionV3 = "3.0.0" as const;

/** V3 keeps the V2 field catalogue and replaces single-effect rules with graphs. */
export const moduleSourceBodyV3Schema = moduleSourceBodyV2Schema.extend({
  rules: z.array(sourceRuleGraphSchema).max(100),
});

/** Candidate format: Definition lifecycle support is required before publication. */
export const moduleSourceDocumentV3Schema = moduleSourceDocumentV2Schema.extend({
  source_contract_version: z.literal(moduleSourceContractVersionV3),
  body: moduleSourceBodyV3Schema,
});

export type ModuleSourceBodyV3 = z.infer<typeof moduleSourceBodyV3Schema>;
export type ModuleSourceDocumentV3 = z.infer<typeof moduleSourceDocumentV3Schema>;
