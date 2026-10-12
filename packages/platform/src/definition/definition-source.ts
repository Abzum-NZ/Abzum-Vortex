import { z } from "zod";
import {
  applicationSourceDocumentSchema,
  sourceApplicationBodySchema,
  sourcePageDefinitionSchema,
} from "./application-source-contracts";
import type {
  ApplicationSourceDocument,
  SourceApplicationBody,
  SourcePageDefinition,
} from "./application-source-contracts";
import { connectionTypeSourceDocumentSchema } from "../connections/connection-source-contracts";
import {
  moduleSourceContractVersion,
  moduleSourceDocumentSchema,
  type ModuleSourceDocument,
} from "./module-source-contracts";
import { moduleValidationContractVersion } from "./module-contracts";
import {
  assertSourceProvenanceCoverage,
  sourceConditionSchema,
  sourceProvenanceRegistry,
  sourceQualifiedConditionSchema,
  sourceProvenanceTarget,
  sourceProvenanceUnchanged,
} from "./definition-source-common";
import type { SourceProvenanceAnnotation } from "./definition-source-common";

/** The one current Module source/validation contract pair and exact release identity. */
export const moduleContractPair = {
  sourceContractVersion: moduleSourceContractVersion,
  validationContractVersion: moduleValidationContractVersion,
} as const;

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
  applicationSourceDocumentSchema,
  connectionTypeSourceDocumentSchema,
  moduleSourceDocumentSchema,
  sourceApplicationBodySchema,
  sourcePageDefinitionSchema,
  sourceConditionSchema,
  sourceQualifiedConditionSchema,
  sourceProvenanceRegistry,
  sourceProvenanceTarget,
  sourceProvenanceUnchanged,
};

export const definitionSourceDocumentSchema = z.discriminatedUnion("kind", [
  moduleSourceDocumentSchema,
  applicationSourceDocumentSchema,
  connectionTypeSourceDocumentSchema,
]);

assertSourceProvenanceCoverage([
  moduleSourceDocumentSchema,
  applicationSourceDocumentSchema,
  connectionTypeSourceDocumentSchema,
]);

export type ConnectionTypeSourceDocument = z.infer<typeof connectionTypeSourceDocumentSchema>;
export type DefinitionSourceDocument = z.infer<typeof definitionSourceDocumentSchema>;
export type {
  ApplicationSourceDocument,
  ModuleSourceDocument,
  SourceProvenanceAnnotation,
  SourceApplicationBody,
  SourcePageDefinition,
};
