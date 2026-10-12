import {
  moduleSourceDocumentSchema,
  type ModuleSourceDocument,
} from "@vortex/platform/schema";
import recordsSource from "./sources/hr.records.json";

/** The private HR records Module, authored independently from its Application. */
export const hrModuleSources: readonly ModuleSourceDocument[] = Object.freeze(
  [recordsSource].map((source) => moduleSourceDocumentSchema.parse(source)),
);
