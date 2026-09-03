import { z } from "zod";
import {
  applicationSourceDocumentSchema,
  sourceBlockSettingValueSchema,
} from "./application-source-contracts";
import { connectionTypeSourceDocumentSchema } from "./connection-source-contracts";
import { moduleSourceDocumentSchema } from "./module-source-contracts";
import { sourceConditionSchema, sourceQualifiedConditionSchema } from "./definition-source-common";

export {
  applicationSourceDocumentSchema,
  connectionTypeSourceDocumentSchema,
  moduleSourceDocumentSchema,
  sourceBlockSettingValueSchema,
  sourceConditionSchema,
  sourceQualifiedConditionSchema,
};

export const definitionSourceDocumentSchema = z.discriminatedUnion("kind", [
  moduleSourceDocumentSchema,
  applicationSourceDocumentSchema,
  connectionTypeSourceDocumentSchema,
]);

export type ModuleSourceDocument = z.infer<typeof moduleSourceDocumentSchema>;
export type ApplicationSourceDocument = z.infer<typeof applicationSourceDocumentSchema>;
export type ConnectionTypeSourceDocument = z.infer<typeof connectionTypeSourceDocumentSchema>;
export type DefinitionSourceDocument = z.infer<typeof definitionSourceDocumentSchema>;
