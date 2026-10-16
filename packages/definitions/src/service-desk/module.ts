import cases from "./modules/cases.json";
import knowledge from "./modules/knowledge.json";
import serviceLevels from "./modules/sla.json";

/** The Modules the Service Desk Application owns, authored inside its Application source. */
export const serviceDeskModules: readonly unknown[] = [serviceLevels, cases, knowledge];
