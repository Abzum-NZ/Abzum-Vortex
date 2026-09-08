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
  moduleSourceDocumentV2Schema,
  type ModuleSourceDocumentV2,
} from "./module-source-contracts-v2";
import { sourceConditionSchema, sourceQualifiedConditionSchema } from "./definition-source-common";

export const moduleSourceDocumentVersionedSchema = z.discriminatedUnion("source_contract_version", [
  moduleSourceDocumentSchema,
  moduleSourceDocumentV2Schema,
]);

export { moduleSourceDocumentSchema as moduleSourceDocumentV1Schema, moduleSourceDocumentV2Schema };

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
  SourceApplicationBodyV2,
  SourcePageDefinitionV2,
};
