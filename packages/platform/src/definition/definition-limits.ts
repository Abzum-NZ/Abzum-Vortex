/**
 * Every numeric limit of a definition that a Studio user can reach, each declared once. The schemas
 * refuse past it, the catalogue validator names it, and Studio states it at the control it applies
 * to (`N of M used` from 80 percent, disabled with the reason once reached). Nothing else spells
 * these numbers. The database mirrors a few of them in `supabase/schemas` (listed in the
 * specification, "Definition limits"); a SQL file cannot import this one, so a change here is made
 * in the same pull request there.
 */
const compositionDepth = 32;
/**
 * The JSON depth the source reader accepts. A block nested `compositionDepth` levels deep sits at
 * three JSON levels per block level (its props, its slot, its place in the list) below the page's
 * own ten levels and above its own settings (six more), so the source bound is derived from the
 * block bound: the two can never disagree.
 */
const sourceNestingDepth = compositionDepth * 3 + 16;
/** A provenance path names a place in a document, so it is as long as the document is deep, plus the compiler's own wrappers. */
const provenancePathSegments = sourceNestingDepth + 16;

export const definitionLimits = Object.freeze({
  fieldsPerRecordType: 500,
  filterableFieldsPerRecordType: 200,
  searchableFieldsPerRecordType: 200,
  sortableFieldsPerRecordType: 8,
  relationshipsPerRecordType: 500,
  pipelinesPerRecordType: 10,
  pipelineStages: 200,
  pipelineTransitions: 1_000,
  choiceOptions: 200,
  recordTypesPerModule: 100,
  queriesPerModule: 100,
  actionsPerModule: 100,
  eventsPerModule: 100,
  extensionPointsPerModule: 100,
  flowsPerOwner: 100,
  flowTriggers: 10,
  actionInputs: 50,
  eventCarriedFields: 30,
  queryColumns: 200,
  queryGroupFields: 10,
  queryTotals: 20,
  querySortKeys: 20,
  queryPageSize: 200,
  pagesPerApplication: 100,
  layoutsPerApplication: 100,
  navigationItems: 100,
  modulesPerApplication: 100,
  usedModulesPerApplication: 100,
  guidedFormSteps: 20,
  searchFieldsPerRecordType: 100,
  searchRecordTypes: 20,
  compositionPlacements: 512,
  compositionDepth,
  sourceImportBytes: 2 * 1024 * 1024,
  sourceNestingDepth,
  provenancePathSegments,
  sourceContainerMembers: 1_000,
  sourceDocumentNodes: 50_000,
  sourceStringLength: 1_000_000,
});

export type DefinitionLimit = keyof typeof definitionLimits;
/** The limits that count things a person adds; the others bound a file or a value. */
export type CountedLimit = Exclude<
  DefinitionLimit,
  | "sourceImportBytes"
  | "sourceNestingDepth"
  | "provenancePathSegments"
  | "sourceContainerMembers"
  | "sourceDocumentNodes"
  | "sourceStringLength"
  | "queryPageSize"
>;

type Wording = Readonly<{ owner: string; noun: string; remedy: string }>;

/** What a limit counts and where, for the one plain sentence every surface shares. */
const limitWording: Readonly<Record<CountedLimit, Wording>> = {
  fieldsPerRecordType: { owner: "A record type", noun: "fields", remedy: "Remove a field first." },
  filterableFieldsPerRecordType: {
    owner: "A record type",
    noun: "filterable fields",
    remedy: "Turn filtering off on another field first.",
  },
  searchableFieldsPerRecordType: {
    owner: "A record type",
    noun: "searchable fields",
    remedy: "Turn search off on another field first.",
  },
  sortableFieldsPerRecordType: {
    owner: "A record type",
    noun: "sortable fields",
    remedy: "Turn sorting off on another field first.",
  },
  relationshipsPerRecordType: {
    owner: "A record type",
    noun: "relationships",
    remedy: "Remove a relationship first.",
  },
  pipelinesPerRecordType: {
    owner: "A record type",
    noun: "pipelines",
    remedy: "Remove a pipeline first.",
  },
  pipelineStages: { owner: "A pipeline", noun: "stages", remedy: "Remove a stage first." },
  pipelineTransitions: {
    owner: "A pipeline",
    noun: "transitions",
    remedy: "Remove a transition first.",
  },
  choiceOptions: { owner: "A choice field", noun: "options", remedy: "Remove an option first." },
  recordTypesPerModule: {
    owner: "A module",
    noun: "record types",
    remedy: "Remove a record type first.",
  },
  queriesPerModule: { owner: "A module", noun: "queries", remedy: "Remove a query first." },
  actionsPerModule: { owner: "A module", noun: "actions", remedy: "Remove an action first." },
  eventsPerModule: { owner: "A module", noun: "events", remedy: "Remove an event first." },
  extensionPointsPerModule: {
    owner: "A module",
    noun: "extension points",
    remedy: "Remove an extension point first.",
  },
  flowsPerOwner: {
    owner: "A module or an application",
    noun: "flows",
    remedy: "Remove a flow first.",
  },
  flowTriggers: { owner: "A flow", noun: "triggers", remedy: "Remove a trigger first." },
  actionInputs: { owner: "An action", noun: "inputs", remedy: "Remove an input first." },
  eventCarriedFields: {
    owner: "An event",
    noun: "carried fields",
    remedy: "Remove a carried field first.",
  },
  queryColumns: { owner: "A query", noun: "columns", remedy: "Remove a column first." },
  queryGroupFields: {
    owner: "A query",
    noun: "grouping fields",
    remedy: "Remove a grouping field first.",
  },
  queryTotals: { owner: "A query", noun: "totals", remedy: "Remove a total first." },
  querySortKeys: {
    owner: "A query",
    noun: "sort fields",
    remedy: "Remove a sort field first.",
  },
  pagesPerApplication: {
    owner: "An application",
    noun: "pages",
    remedy: "Remove a page first.",
  },
  layoutsPerApplication: {
    owner: "An application",
    noun: "layouts",
    remedy: "Remove a layout first.",
  },
  navigationItems: {
    owner: "An application menu",
    noun: "items",
    remedy: "Remove an item first.",
  },
  modulesPerApplication: {
    owner: "An application",
    noun: "modules",
    remedy: "Remove a module first.",
  },
  usedModulesPerApplication: {
    owner: "An application",
    noun: "used modules",
    remedy: "Stop using a module first.",
  },
  guidedFormSteps: { owner: "A guided form", noun: "steps", remedy: "Remove a step first." },
  searchFieldsPerRecordType: {
    owner: "A record type in search",
    noun: "fields",
    remedy: "Remove a field from search first.",
  },
  searchRecordTypes: {
    owner: "Application search",
    noun: "record types",
    remedy: "Remove a record type from search first.",
  },
  compositionPlacements: {
    owner: "An application",
    noun: "blocks across its pages and layouts",
    remedy: "Remove a block first.",
  },
  compositionDepth: {
    owner: "A page",
    noun: "levels of nested blocks",
    remedy: "Move a block out of its container.",
  },
};

/** The plain refusal for a limit: "A record type can have up to 8 sortable fields. ..." */
export const definitionLimitMessage = (limit: CountedLimit): string => {
  const { owner, noun, remedy } = limitWording[limit];
  return `${owner} can have up to ${definitionLimits[limit]} ${noun}. ${remedy}`;
};

/** `N of M used`: the one way a limit's usage reads at its control. */
export const definitionLimitUsage = (limit: DefinitionLimit, used: number): string =>
  `${used} of ${definitionLimits[limit]} used`;

export const definitionLimitReached = (limit: DefinitionLimit, used: number): boolean =>
  used >= definitionLimits[limit];

/** The share of a limit from which a usage line shows and an inspector group opens. */
export const definitionLimitNearShare = 0.8;

export const definitionLimitNear = (limit: DefinitionLimit, used: number): boolean =>
  used >= definitionLimits[limit] * definitionLimitNearShare;

/** The import size as a person reads it: "2 MiB". */
export const definitionLimitImportSize = `${definitionLimits.sourceImportBytes / (1024 * 1024)} MiB`;

/** Every limit that counts what a person adds, for a reader that matches a refusal to its limit. */
export const countedDefinitionLimits: readonly CountedLimit[] = (
  Object.keys(definitionLimits) as DefinitionLimit[]
).filter((limit): limit is CountedLimit => limit in limitWording);
