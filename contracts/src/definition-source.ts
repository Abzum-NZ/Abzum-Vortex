import { z } from "zod";
import {
  applicationSourceDocumentV2Schema,
  sourceApplicationBodyV2Schema,
  sourcePageDefinitionV2Schema,
} from "./application-source-contracts";
import type {
  ApplicationSourceDocumentV2,
  SourceApplicationBodyV2,
  SourcePageDefinitionV2,
} from "./application-source-contracts";
import { connectionTypeSourceDocumentSchema } from "./connection-source-contracts";
import {
  moduleSourceContractVersion,
  moduleSourceDocumentSchema,
  type ModuleSourceDocument,
} from "./module-source-contracts";
import { moduleValidationContractVersionV3 } from "./module-contracts-v3";
import { sourceConditionSchema, sourceQualifiedConditionSchema } from "./definition-source-common";

/** The one current Module source/validation contract pair and exact release identity. */
export const moduleContractPair = {
  sourceContractVersion: moduleSourceContractVersion,
  validationContractVersion: moduleValidationContractVersionV3,
} as const;

export type ModuleContractPair = typeof moduleContractPair;

/** Refuses any pair other than the one current Module source/validation contract. */
export const assertModuleContractPair = (
  sourceContractVersion: string,
  validationContractVersion: string,
): void => {
  if (
    sourceContractVersion !== moduleContractPair.sourceContractVersion ||
    validationContractVersion !== moduleContractPair.validationContractVersion
  )
    throw new TypeError("Unsupported Module source and validation contract version pair");
};

export {
  applicationSourceDocumentV2Schema,
  connectionTypeSourceDocumentSchema,
  moduleSourceDocumentSchema,
  sourceApplicationBodyV2Schema,
  sourcePageDefinitionV2Schema,
  sourceConditionSchema,
  sourceQualifiedConditionSchema,
};

export const definitionSourceDocumentSchema = z.discriminatedUnion("kind", [
  moduleSourceDocumentSchema,
  applicationSourceDocumentV2Schema,
  connectionTypeSourceDocumentSchema,
]);

export type ApplicationSourceDocument = z.infer<typeof applicationSourceDocumentV2Schema>;
export type ConnectionTypeSourceDocument = z.infer<typeof connectionTypeSourceDocumentSchema>;
export type DefinitionSourceDocument = z.infer<typeof definitionSourceDocumentSchema>;
export type {
  ApplicationSourceDocumentV2,
  ModuleSourceDocument,
  SourceApplicationBodyV2,
  SourcePageDefinitionV2,
};
