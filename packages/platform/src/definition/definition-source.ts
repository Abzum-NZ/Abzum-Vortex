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
  moduleSourceDocumentSchema,
  sourceApplicationModuleSchema,
  type ModuleSourceDocument,
  type SourceApplicationModule,
} from "./module-source-contracts";
import {
  assertSourceProvenanceCoverage,
  sourceConditionSchema,
  sourceProvenanceRegistry,
  sourceQualifiedConditionSchema,
  sourceProvenanceTarget,
  sourceProvenanceUnchanged,
} from "./definition-source-common";
import type { SourceProvenanceAnnotation } from "./definition-source-common";

export {
  applicationSourceDocumentSchema,
  connectionTypeSourceDocumentSchema,
  moduleSourceDocumentSchema,
  sourceApplicationModuleSchema,
  sourceApplicationBodySchema,
  sourcePageDefinitionSchema,
  sourceConditionSchema,
  sourceQualifiedConditionSchema,
  sourceProvenanceRegistry,
  sourceProvenanceTarget,
  sourceProvenanceUnchanged,
};

/**
 * Every stored definition source. The Module arm is the internal release unit derived from an
 * Application's inline Modules (`applicationModuleSources`); nobody authors one directly.
 */
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
  SourceApplicationModule,
  SourceProvenanceAnnotation,
  SourceApplicationBody,
  SourcePageDefinition,
};
