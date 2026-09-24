import {
  moduleSourceDocumentSchema,
  type ModuleSourceDocument,
} from "@vortex/contracts";
import activitiesSource from "./sources/crm.activities.json";
import opportunitiesSource from "./sources/crm.opportunities.json";
import organisationsSource from "./sources/crm.organisations.json";
import peopleSource from "./sources/crm.people.json";
import tagsSource from "./sources/crm.tags.json";

/** Current CRM Modules shipped with the CRM application definitions. */
export const crmModuleSources: readonly ModuleSourceDocument[] = Object.freeze(
  [
    organisationsSource,
    peopleSource,
    opportunitiesSource,
    activitiesSource,
    tagsSource,
  ].map((source) => moduleSourceDocumentSchema.parse(source)),
);
