import {
  moduleSourceDocumentSchema,
  type ModuleSourceDocument,
} from "@vortex/contracts";
import casesSource from "./sources/service-desk.cases.json";
import knowledgeSource from "./sources/service-desk.knowledge.json";
import serviceLevelsSource from "./sources/service-desk.sla.json";

/** Current Service Desk Modules shipped with the Service Desk application. */
export const serviceDeskModuleSources: readonly ModuleSourceDocument[] = Object.freeze(
  [casesSource, knowledgeSource, serviceLevelsSource].map((source) =>
    moduleSourceDocumentSchema.parse(source),
  ),
);
