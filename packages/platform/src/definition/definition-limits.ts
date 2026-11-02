/**
 * Every numeric limit of a definition that a Studio user can reach, each declared once. The schemas
 * refuse past it, the catalogue validator names it, and Studio states it at the control it applies
 * to (`N of M used`, disabled with the reason once reached). Nothing else spells these numbers.
 */
export const definitionLimits = Object.freeze({
  fieldsPerRecordType: 500,
  sortableFieldsPerRecordType: 8,
  pipelinesPerRecordType: 10,
  pipelineStages: 200,
  pipelineTransitions: 1_000,
  choiceOptions: 200,
  recordTypesPerModule: 100,
  queriesPerModule: 100,
  actionsPerModule: 100,
  eventsPerModule: 100,
  flowsPerModule: 100,
  actionInputs: 50,
  queryTotals: 20,
  querySortKeys: 20,
  queryPageSize: 200,
  compositionPlacements: 512,
  compositionDepth: 32,
  sourceImportBytes: 2 * 1024 * 1024,
  sourceNestingDepth: 32,
  sourceContainerMembers: 1_000,
});

export type DefinitionLimit = keyof typeof definitionLimits;
export type CountedLimit = Exclude<
  DefinitionLimit,
  "sourceImportBytes" | "sourceNestingDepth" | "sourceContainerMembers"
>;

type Wording = Readonly<{ owner: string; noun: string; remedy: string }>;

/** What a limit counts and where, for the one plain sentence every surface shares. */
const limitWording: Readonly<Record<CountedLimit, Wording>> = {
  fieldsPerRecordType: { owner: "A record type", noun: "fields", remedy: "Remove a field first." },
  sortableFieldsPerRecordType: {
    owner: "A record type",
    noun: "sortable fields",
    remedy: "Turn sorting off on another field first.",
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
  flowsPerModule: { owner: "A module", noun: "flows", remedy: "Remove a flow first." },
  actionInputs: { owner: "An action", noun: "inputs", remedy: "Remove an input first." },
  queryTotals: { owner: "A query", noun: "totals", remedy: "Remove a total first." },
  querySortKeys: {
    owner: "A query",
    noun: "sort fields",
    remedy: "Remove a sort field first.",
  },
  queryPageSize: {
    owner: "A query",
    noun: "records per page",
    remedy: "Lower the page size.",
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
