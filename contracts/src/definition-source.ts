import { z } from "zod";
import {
  applicationSourceDocumentSchema,
  applicationSourceDocumentV1Schema,
  applicationSourceDocumentV2Schema,
  sourceBlockSettingValueSchema,
  sourceApplicationBodyV2Schema,
  sourcePageDefinitionV2Schema,
} from "./application-source-contracts";
import type {
  ApplicationSourceDocumentV2,
  SourceApplicationBodyV2,
  SourcePageDefinitionV2,
} from "./application-source-contracts";
import { connectionTypeSourceDocumentSchema } from "./connection-source-contracts";
import { moduleSourceDocumentSchema } from "./module-source-contracts";
import {
  moduleSourceContractVersionV2,
  moduleSourceDocumentV2Schema,
  type ModuleSourceDocumentV2,
} from "./module-source-contracts-v2";
import { moduleValidationContractVersionV2 } from "./module-contracts-v2";
import {
  moduleSourceContractVersionV3,
  moduleSourceDocumentV3Schema,
  type ModuleSourceDocumentV3,
} from "./module-source-contracts-v3";
import { moduleValidationContractVersionV3 } from "./module-contracts-v3";
import { sourceConditionSchema, sourceQualifiedConditionSchema } from "./definition-source-common";

export const moduleSourceDocumentVersionedSchema = z.discriminatedUnion("source_contract_version", [
  moduleSourceDocumentSchema,
  moduleSourceDocumentV2Schema,
  moduleSourceDocumentV3Schema,
]);

export const moduleContractPairV1 = {
  schema: "v1",
  sourceContractVersion: "1.0.0",
  validationContractVersion: "1.0.0",
} as const;

export const moduleContractPairV2 = {
  schema: "v2",
  sourceContractVersion: moduleSourceContractVersionV2,
  validationContractVersion: moduleValidationContractVersionV2,
} as const;

export const moduleContractPairV3 = {
  schema: "v3",
  sourceContractVersion: moduleSourceContractVersionV3,
  validationContractVersion: moduleValidationContractVersionV3,
} as const;

export type ModuleContractPair =
  typeof moduleContractPairV1 | typeof moduleContractPairV2 | typeof moduleContractPairV3;

/** Selects exact known pairs; each runtime operation separately gates implemented support. */
export const selectModuleContractPair = (
  sourceContractVersion: string,
  validationContractVersion: string,
): ModuleContractPair => {
  if (sourceContractVersion === "1.0.0" && validationContractVersion === "1.0.0")
    return moduleContractPairV1;
  if (
    sourceContractVersion === moduleSourceContractVersionV2 &&
    validationContractVersion === moduleValidationContractVersionV2
  )
    return moduleContractPairV2;
  if (
    sourceContractVersion === moduleSourceContractVersionV3 &&
    validationContractVersion === moduleValidationContractVersionV3
  )
    return moduleContractPairV3;
  throw new TypeError("Unsupported Module source and validation contract version pair");
};

export {
  moduleSourceDocumentSchema as moduleSourceDocumentV1Schema,
  moduleSourceDocumentV2Schema,
  moduleSourceDocumentV3Schema,
};

export {
  applicationSourceDocumentSchema,
  applicationSourceDocumentV1Schema,
  applicationSourceDocumentV2Schema,
  connectionTypeSourceDocumentSchema,
  moduleSourceDocumentSchema,
  sourceBlockSettingValueSchema,
  sourceApplicationBodyV2Schema,
  sourcePageDefinitionV2Schema,
  sourceConditionSchema,
  sourceQualifiedConditionSchema,
};

export const definitionSourceDocumentSchema = z.discriminatedUnion("kind", [
  moduleSourceDocumentSchema,
  applicationSourceDocumentSchema,
  connectionTypeSourceDocumentSchema,
]);

export type ModuleSourceDocument = z.infer<typeof moduleSourceDocumentSchema>;
export type ModuleSourceDocumentV1 = ModuleSourceDocument;
export type ModuleSourceDocumentVersioned = z.infer<typeof moduleSourceDocumentVersionedSchema>;
export type ApplicationSourceDocument = z.infer<typeof applicationSourceDocumentSchema>;
export type ConnectionTypeSourceDocument = z.infer<typeof connectionTypeSourceDocumentSchema>;
export type DefinitionSourceDocument = z.infer<typeof definitionSourceDocumentSchema>;
export type {
  ApplicationSourceDocumentV2,
  ModuleSourceDocumentV2,
  ModuleSourceDocumentV3,
  SourceApplicationBodyV2,
  SourcePageDefinitionV2,
};
