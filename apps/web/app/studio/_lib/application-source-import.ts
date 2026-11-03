import { z } from "zod";
import {
  applicationRootIdSchema,
  applicationSourceDocumentSchema,
  fingerprintSchema,
  definitionValidationResultSchema,
  organizationIdSchema,
  revisionSchema,
  canonicalJson,
  definitionLimitMessage,
  countedDefinitionLimits,
  definitionLimitImportSize,
  definitionLimits,
  type ApplicationSourceDocument,
  type CountedLimit,
} from "@vortex/platform/schema";

export const studioApplicationSourceReviewRequestSchema = z
  .object({
    rootId: applicationRootIdSchema,
    expectedDraftRevision: revisionSchema,
    expectedSavedSourceFingerprint: fingerprintSchema,
    source: applicationSourceDocumentSchema,
  })
  .strict();

const sourceReviewBinding = {
  organizationId: organizationIdSchema,
  rootId: applicationRootIdSchema,
  key: applicationSourceDocumentSchema.shape.key,
  rootAlias: applicationSourceDocumentSchema.shape.root_alias,
  draftRevision: revisionSchema,
  savedSourceFingerprint: fingerprintSchema,
  candidateSourceFingerprint: fingerprintSchema,
};

export const studioApplicationSourceReviewResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("available"),
      ...sourceReviewBinding,
      source: applicationSourceDocumentSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("validation_failed"),
      ...sourceReviewBinding,
      validation: definitionValidationResultSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("identity_conflict"),
      ...sourceReviewBinding,
      conflicts: z.array(z.object({ kind: z.string(), name: z.string() }).strict()).min(1),
    })
    .strict(),
  z.object({ kind: z.literal("invalid") }).strict(),
  z.object({ kind: z.literal("conflict") }).strict(),
  z.object({ kind: z.literal("refused") }).strict(),
  z.object({ kind: z.literal("temporarily_unavailable") }).strict(),
]);

export type StudioApplicationSourceReviewResult = z.infer<
  typeof studioApplicationSourceReviewResultSchema
>;

/** A local editor frame, never a permission decision or a saved-draft receipt. */
export type StudioApplicationSourceImportSnapshot = Readonly<{
  organizationId: string;
  rootId: string;
  key: string;
  rootAlias: string;
  draftRevision: number;
  savedSourceFingerprint: string;
  source: ApplicationSourceDocument;
  localLifetime: number;
}>;

export const sameStudioApplicationSourceImportSnapshot = (
  expected: StudioApplicationSourceImportSnapshot,
  current: StudioApplicationSourceImportSnapshot | null,
): boolean =>
  current !== null &&
  expected.organizationId === current.organizationId &&
  expected.rootId === current.rootId &&
  expected.key === current.key &&
  expected.rootAlias === current.rootAlias &&
  expected.draftRevision === current.draftRevision &&
  expected.savedSourceFingerprint === current.savedSourceFingerprint &&
  expected.localLifetime === current.localLifetime &&
  canonicalJson(expected.source) === canonicalJson(current.source);

/**
 * Inspect raw member names before JSON.parse can silently discard a duplicate. Returns what is
 * wrong in a builder's words, or nothing when the text is unambiguous.
 */
function ambiguousMembers(text: string): string | undefined {
  const containers: (Set<string> | null)[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") containers.push(new Set());
    else if (character === "[") containers.push(null);
    else if (character === "}" || character === "]") containers.pop();
    else if (character === '"') {
      const start = index;
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\\") index += 1;
        index += 1;
      }
      if (index >= text.length) return "The JSON source ends inside a text value.";
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next]!)) next += 1;
      if (text[next] === ":") {
        const members = containers[containers.length - 1];
        if (members === undefined || members === null)
          return "The JSON source has a member name outside an object.";
        const name: unknown = JSON.parse(text.slice(start, index + 1));
        if (typeof name !== "string" || members.has(name))
          return `The JSON source names "${String(name)}" twice in one object. Remove the duplicate.`;
        members.add(name);
        if (members.size > definitionLimits.sourceContainerMembers)
          return `An object in the JSON source has more than ${definitionLimits.sourceContainerMembers} members, the most one may have. Remove some.`;
      }
    }
    // The body bound is `definitionLimits.sourceNestingDepth`; the envelope adds the root and body containers.
    if (containers.length > definitionLimits.sourceNestingDepth + 2)
      return `The JSON source nests objects and lists more than ${definitionLimits.sourceNestingDepth} levels deep, the most it may. Flatten the deepest part.`;
  }
  return undefined;
}

const itemKinds: Readonly<Record<string, string>> = {
  modules: "module",
  record_types: "record type",
  fields: "field",
  actions: "action",
  flows: "flow",
  pages: "page",
  permissions: "permission",
  roles: "role",
  queries: "query",
  tasks: "step",
};

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nameOf = (item: unknown): string | undefined => {
  if (!isObject(item)) return undefined;
  const labels = item.labels;
  const candidates = [
    isObject(labels) ? labels.name : undefined,
    item.label,
    item.name,
    item.key,
    item.id,
  ];
  return candidates.find((entry): entry is string => typeof entry === "string");
};

/** Where in the file an issue is, in the builder's words: the module, action or flow by its name. */
const describeIssuePlace = (input: unknown, path: readonly PropertyKey[]): string => {
  const places: string[] = [];
  let current: unknown = input;
  path.forEach((segment, index) => {
    current =
      isObject(current) || Array.isArray(current)
        ? (current as Record<PropertyKey, unknown>)[segment]
        : undefined;
    const parent = path[index - 1];
    if (typeof segment === "number" && typeof parent === "string") {
      const kind = itemKinds[parent];
      const name = nameOf(current);
      if (kind !== undefined && name !== undefined) places.push(`${kind} "${name}"`);
    }
  });
  return places.length === 0 ? "the file" : places.reverse().join(" of ");
};

/** The limit a list of the source is held to, by the list's name and where it sits. */
const limitOfList = (path: readonly PropertyKey[]): CountedLimit | undefined => {
  const list = path.at(-1);
  const inSearch = path.includes("search");
  switch (list) {
    case "fields":
      return inSearch ? "searchFieldsPerRecordType" : "fieldsPerRecordType";
    case "record_types":
      return inSearch ? "searchRecordTypes" : "recordTypesPerModule";
    case "queries":
      return "queriesPerModule";
    case "actions":
      return "actionsPerModule";
    case "events":
      return "eventsPerModule";
    case "extension_points":
      return "extensionPointsPerModule";
    case "flows":
      return "flowsPerOwner";
    case "triggers":
      return "flowTriggers";
    case "inputs":
      return "actionInputs";
    case "carries":
      return "eventCarriedFields";
    case "select":
      return "queryColumns";
    case "group_by":
      return "queryGroupFields";
    case "aggregates":
      return "queryTotals";
    case "sort":
      return "querySortKeys";
    case "options":
      return "choiceOptions";
    case "stages":
      return "pipelineStages";
    case "transitions":
      return "pipelineTransitions";
    case "pipelines":
      return "pipelinesPerRecordType";
    case "relationships":
      return "relationshipsPerRecordType";
    case "pages":
      return "pagesPerApplication";
    case "shells":
      return "layoutsPerApplication";
    case "navigation":
    case "children":
      return "navigationItems";
    case "modules":
      return "modulesPerApplication";
    case "uses":
      return "usedModulesPerApplication";
    case "steps":
      return "guidedFormSteps";
    default:
      return undefined;
  }
};

/** A value past a limit no list names: where it is and by how much. */
const describeSourceBound = (where: string, issue: z.core.$ZodIssueTooBig): string => {
  const property = issue.path.at(-1);
  const name = typeof property === "string" ? property.replaceAll("_", " ") : "value";
  const limit = String(issue.maximum);
  if (issue.origin === "string")
    return `In ${where}, "${name}" can be at most ${limit} characters long. Shorten it and check the file again.`;
  return `In ${where}, "${name}" can be at most ${limit}. Lower it and check the file again.`;
};

/** Where in the draft a refusal points: the module, and the record type when the file names one. */
export type StudioSourceImportShowMe = Readonly<{ moduleKey: string; recordKey?: string }>;

type SourceImportIssue = Readonly<{ message: string; showMe?: StudioSourceImportShowMe }>;

const limitMessages: ReadonlySet<string> = new Set(
  countedDefinitionLimits.map((limit) => definitionLimitMessage(limit)),
);

/** The module and record type an issue sits in, read from the file. */
const placeOfIssue = (
  input: unknown,
  path: readonly PropertyKey[],
): StudioSourceImportShowMe | undefined => {
  const keyAt = (end: number): string | undefined => {
    let current: unknown = input;
    for (const segment of path.slice(0, end)) {
      current =
        isObject(current) || Array.isArray(current)
          ? (current as Record<PropertyKey, unknown>)[segment]
          : undefined;
    }
    return isObject(current) && typeof current.key === "string" ? current.key : undefined;
  };
  const moduleAt = path.indexOf("modules");
  if (moduleAt < 0 || typeof path[moduleAt + 1] !== "number") return undefined;
  const moduleKey = keyAt(moduleAt + 2);
  if (moduleKey === undefined) return undefined;
  const recordAt = path.indexOf("record_types");
  const recordKey =
    recordAt > moduleAt && typeof path[recordAt + 1] === "number" ? keyAt(recordAt + 2) : undefined;
  return recordKey === undefined ? { moduleKey } : { moduleKey, recordKey };
};

/**
 * The sentence for a source that does not read as the current contract: what is wrong, where, and
 * what to change. A limit is worded exactly as Studio words it at its control. A file of an older
 * contract is told to be exported again.
 */
const describeSourceImportIssue = (input: unknown, issue: z.core.$ZodIssue): SourceImportIssue => {
  const current = applicationSourceDocumentSchema.shape.source_contract_version.value;
  if (issue.path[0] === "source_contract_version") {
    const found = isObject(input) ? input.source_contract_version : undefined;
    return {
      message: `This file is source contract ${typeof found === "string" ? found : "unknown"}, and Studio reads ${current}. Export the application again from a current Studio, or change what the newer contract changed in the file and set source_contract_version to ${current}.`,
    };
  }
  const where = describeIssuePlace(input, issue.path);
  const showMe = placeOfIssue(input, issue.path);
  const found =
    issue.code === "too_big" && issue.origin === "array" ? limitOfList(issue.path) : undefined;
  if (found !== undefined)
    return {
      message: `In ${where}: ${definitionLimitMessage(found)}`,
      ...(showMe ? { showMe } : {}),
    };
  if (limitMessages.has(issue.message))
    return { message: `In ${where}: ${issue.message}`, ...(showMe ? { showMe } : {}) };
  if (issue.code === "too_big")
    return { message: describeSourceBound(where, issue), ...(showMe ? { showMe } : {}) };
  if (issue.code === "unrecognized_keys") {
    const keys = issue.keys.map((key) => `"${key}"`).join(", ");
    if (issue.keys.includes("tasks") && issue.path.at(-2) === "actions")
      return {
        message: `In ${where}, ${keys} is not used any more: put its steps in a Module flow and name that flow in the action's "flow".`,
      };
    return {
      message: `In ${where}, ${keys} ${issue.keys.length === 1 ? "is" : "are"} not part of source contract ${current}. Remove ${issue.keys.length === 1 ? "it" : "them"}.`,
    };
  }
  const property = issue.path.at(-1);
  const last = typeof property === "string" ? ` "${property}"` : "";
  return {
    message: `In ${where}, the property${last} is not valid: ${issue.message}. Change it to match source contract ${current}.`,
  };
};

export function readStudioApplicationSourceImport(
  text: string,
  key: string,
  rootAlias: string,
):
  | Readonly<{ kind: "valid"; source: ApplicationSourceDocument }>
  | Readonly<{ kind: "invalid"; message: string; showMe?: StudioSourceImportShowMe }> {
  if (
    text.length > definitionLimits.sourceImportBytes ||
    new TextEncoder().encode(text).byteLength > definitionLimits.sourceImportBytes
  )
    return {
      kind: "invalid",
      message: `The JSON source must be at most ${definitionLimitImportSize}.`,
    };
  try {
    const ambiguity = ambiguousMembers(text);
    if (ambiguity !== undefined) return { kind: "invalid", message: ambiguity };
    const input: unknown = JSON.parse(text);
    const parsed = applicationSourceDocumentSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return { kind: "invalid", ...describeSourceImportIssue(input, issue) };
    }
    if (parsed.data.key !== key || parsed.data.root_alias !== rootAlias)
      return {
        kind: "invalid",
        message:
          "This file is for a different application. Export this application's file and try again.",
      };
    return { kind: "valid", source: parsed.data };
  } catch {
    return {
      kind: "invalid",
      message: "The source could not be read as valid authored Application JSON.",
    };
  }
}
