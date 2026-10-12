import {
  moduleSourceDocumentSchema,
  type ModuleSourceDocument,
} from "@vortex/platform/schema";
import incidentsSource from "./sources/operations.incidents.json";

/** Current Operations Module sources shipped with the Operations application. */
export const operationsModuleSources: readonly ModuleSourceDocument[] = Object.freeze(
  [incidentsSource].map((source) => moduleSourceDocumentSchema.parse(source)),
);
