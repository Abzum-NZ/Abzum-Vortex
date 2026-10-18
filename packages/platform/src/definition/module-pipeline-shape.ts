import { builderKeySchema } from "../catalogue/identifiers";
import {
  applicationSourceDocumentSchema,
  type ApplicationSourceDocument,
} from "./application-source-contracts";
import type { ModuleFieldPublication } from "./module-field-edit";
import { applicationUses, type ApplicationUsePlace } from "./application-uses";
import type { PipelineStageTone } from "./record-type-pipelines";

type InlineModule = ApplicationSourceDocument["body"]["modules"][number];
type RecordType = InlineModule["record_types"][number];
type Pipeline = RecordType["pipelines"][number];
type ModuleAction = InlineModule["actions"][number];

/**
 * One pipeline of an owned Module's record type as Studio edits it: its name, the choice field it
 * follows, its stages in board order with their colour roles, the moves between them, and the named
 * action that owns each gated stage. Gating is the action model's: an action that sets the stage's
 * option owns it, so saving that option anywhere runs the action with its permission and condition.
 */
export type InlinePipelineChange = Readonly<{
  moduleKey: string;
  recordKey: string;
  /** The pipeline's key; absent for a new pipeline. */
  pipelineKey?: string;
  name: string;
  /** The choice field's key; fixed once the pipeline exists. */
  stageField: string;
  stages: readonly Readonly<{ option: string; tone: PipelineStageTone }>[];
  transitions: readonly Readonly<{ from: string; to: string }>[];
  /** The key of the action that owns each gated stage, by option; a stage not named is not gated. */
  gates: Readonly<Record<string, string>>;
  /** Options to take off the choice field with their stages, refused while anything uses them. */
  removedOptions: readonly string[];
}>;

export type InlinePipelineResult =
  | Readonly<{ kind: "changed"; source: ApplicationSourceDocument; pipelineKey: string }>
  | Readonly<{ kind: "invalid"; issues: readonly string[] }>
  | Readonly<{
      kind: "referenced";
      issue: string;
      references: readonly ApplicationUsePlace[];
    }>;

type Located = Readonly<{
  module: InlineModule;
  moduleIndex: number;
  record: RecordType;
  recordIndex: number;
}>;

const locate = (
  source: ApplicationSourceDocument,
  moduleKey: string,
  recordKey: string,
): Located | undefined => {
  const moduleIndex = source.body.modules.findIndex((module) => module.key === moduleKey);
  const module = source.body.modules[moduleIndex];
  const recordIndex = module?.record_types.findIndex((record) => record.key === recordKey) ?? -1;
  const record = module?.record_types[recordIndex];
  return module === undefined || record === undefined
    ? undefined
    : { module, moduleIndex, record, recordIndex };
};

const choiceOptions = (
  record: RecordType,
  fieldKey: string,
): readonly { value: string; label: string }[] | undefined => {
  const field = record.fields.find((candidate) => candidate.key === fieldKey);
  return field?.type === "choice"
    ? (field.settings as { options: { value: string; label: string }[] }).options
    : undefined;
};

const literalOf = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  const flowValue = value as { kind?: string; literal?: { value?: unknown } };
  return flowValue.kind === "literal" ? flowValue.literal?.value : undefined;
};

/**
 * Whether a named action sets one choice field to exactly one option, and no other choice field,
 * so it can own that option (the action model's rule for owning a choice).
 */
export const inlineActionSetsOption = (
  record: RecordType,
  action: ModuleAction,
  fieldKey: string,
  option: string,
): boolean => {
  if (action.record_type !== record.key || action.protected_operation !== undefined) return false;
  const choices: unknown[] = [];
  for (const task of action.tasks) {
    if (task.type !== "record.set_fields") continue;
    const values = (task.properties as { values?: Record<string, unknown> }).values ?? {};
    for (const [key, value] of Object.entries(values))
      if (record.fields.find((field) => field.key === key)?.type === "choice")
        choices.push([key, literalOf(value)]);
  }
  return choices.length === 1 && JSON.stringify(choices[0]) === JSON.stringify([fieldKey, option]);
};

/** The named action that owns one option of a choice field, if one does. */
export const inlineOptionOwner = (
  module: InlineModule,
  record: RecordType,
  fieldKey: string,
  option: string,
): ModuleAction | undefined =>
  module.actions.find(
    (action) =>
      action.record_type === record.key &&
      action.sets_choice_field === fieldKey &&
      action.sets_choice_option === option,
  );

const nameFrom = (label: string): string => {
  const words = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (/^[a-z]/.test(words) ? words : `pipeline_${words}`).slice(0, 40).replace(/_+$/, "");
};

const unique = (base: string, taken: ReadonlySet<string>, limit: number): string => {
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? base.slice(0, limit) : `${base.slice(0, limit - 4)}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
};

const moduleAliases = (module: InlineModule): Set<string> =>
  new Set([
    module.id,
    ...module.record_types.flatMap((record) => [
      record.id,
      record.storage_contract_id,
      ...record.fields.map((field) => field.id),
      ...record.relationships.map((relationship) => relationship.id),
      ...record.pipelines.map((pipeline) => pipeline.id),
    ]),
    ...module.permissions.map((permission) => permission.id),
    ...module.actions.map((action) => action.id),
    ...module.events.map((event) => event.id),
    ...module.queries.map((query) => query.id),
  ]);

const parsed = (source: ApplicationSourceDocument, pipelineKey: string): InlinePipelineResult => {
  const result = applicationSourceDocumentSchema.safeParse(source);
  return result.success
    ? { kind: "changed", source: result.data, pipelineKey }
    : {
        kind: "invalid",
        issues: [...new Set(result.error.issues.map((issue) => `${issue.message}.`))],
      };
};

/**
 * Creates or changes one pipeline of an owned Module's record type, its gates and, when asked, the
 * removal of options from its choice field. A removed option is refused while anything uses it and
 * while its field is in a published version (records already stored may hold it).
 */
export const saveInlinePipeline = (
  current: ApplicationSourceDocument,
  change: InlinePipelineChange,
  publication: ModuleFieldPublication,
): InlinePipelineResult => {
  const source = structuredClone(current);
  const located = locate(source, change.moduleKey, change.recordKey);
  if (located === undefined)
    return {
      kind: "invalid",
      issues: ["The record type is not in this application's modules any more."],
    };
  const { module, record } = located;
  const existing =
    change.pipelineKey === undefined
      ? undefined
      : record.pipelines.find((pipeline) => pipeline.key === change.pipelineKey);
  if (change.pipelineKey !== undefined && existing === undefined)
    return { kind: "invalid", issues: ["This pipeline is not on the record type any more."] };
  const issues: string[] = [];
  const name = change.name.trim();
  if (name.length < 1 || name.length > 60)
    issues.push(
      "Name: give the pipeline a name of at most 60 characters, such as Asset lifecycle.",
    );
  if (existing !== undefined && existing.stage_field !== change.stageField)
    issues.push(
      "Field: a pipeline keeps the choice field it follows. Delete it and create another to follow a different field.",
    );
  const field = record.fields.find((candidate) => candidate.key === change.stageField);
  const options = choiceOptions(record, change.stageField);
  if (field === undefined || options === undefined) {
    issues.push(`Field: choose a choice field of ${record.plural_name}.`);
    return { kind: "invalid", issues };
  }
  if (
    existing === undefined &&
    record.pipelines.some((pipeline) => pipeline.stage_field === change.stageField)
  )
    issues.push(
      `Field: ${field.label} already has a pipeline. A choice field follows one pipeline.`,
    );
  const labelOf = (value: string) =>
    options.find((option) => option.value === value)?.label ?? value;

  // Removed options leave the field, with their stages, moves and gates.
  const removed = new Set(change.removedOptions);
  if (removed.size > 0) {
    if (publication.fields.has(`${module.key}:${record.key}.${field.key}`))
      return {
        kind: "invalid",
        issues: [
          `${field.label} is in a published version, so its options can't be removed: ` +
            "records already stored may hold them.",
        ],
      };
    for (const option of removed) {
      const references = applicationUses(current, {
        kind: "choice_option",
        moduleKey: module.key,
        recordKey: record.key,
        fieldKey: field.key,
        option,
      });
      if (references.length > 0)
        return {
          kind: "referenced",
          references,
          issue: `${labelOf(option)} is used in ${references.length === 1 ? "one place" : `${references.length} places`}, so it can't be removed. Remove those uses first.`,
        };
    }
    if (options.every((option) => removed.has(option.value)))
      return {
        kind: "invalid",
        issues: [`${field.label} needs at least one option, so not every stage can be removed.`],
      };
    (field.settings as { options: { value: string }[] }).options = options.filter(
      (option) => !removed.has(option.value),
    );
    if (field.default !== undefined && removed.has(String(field.default)))
      delete (field as { default?: unknown }).default;
  }
  const kept = options.filter((option) => !removed.has(option.value)).map((option) => option.value);
  const stages = change.stages.filter((stage) => !removed.has(stage.option));
  if (
    stages.length !== kept.length ||
    kept.some((option) => !stages.some((stage) => stage.option === option))
  )
    issues.push(`Stages: every option of ${field.label} is one stage, once.`);
  const transitions = change.transitions.filter(
    (move) => !removed.has(move.from) && !removed.has(move.to),
  );
  for (const move of transitions)
    if (move.from === move.to || !kept.includes(move.from) || !kept.includes(move.to))
      issues.push(
        `Moves: ${labelOf(move.from)} to ${labelOf(move.to)} is not a move between two stages.`,
      );

  // Gates: the action that owns each stage. Only an action that sets the field to that option can.
  const gateIssues: string[] = [];
  for (const option of kept) {
    const wanted = change.gates[option];
    const action =
      wanted === undefined
        ? undefined
        : module.actions.find((candidate) => candidate.key === wanted);
    if (
      wanted !== undefined &&
      (action === undefined || !inlineActionSetsOption(record, action, field.key, option))
    )
      gateIssues.push(
        `Gate of ${labelOf(option)}: choose an action of ${record.plural_name} that sets ${field.label} to ${labelOf(option)}.`,
      );
  }
  issues.push(...gateIssues);
  if (issues.length > 0) return { kind: "invalid", issues };
  for (const option of [...kept, ...removed]) {
    const owner = inlineOptionOwner(module, record, field.key, option);
    const wanted = removed.has(option) ? undefined : change.gates[option];
    if (owner !== undefined && owner.key !== wanted) {
      delete (owner as { sets_choice_field?: string }).sets_choice_field;
      delete (owner as { sets_choice_option?: string }).sets_choice_option;
    }
  }
  for (const option of kept) {
    const wanted = change.gates[option];
    const action =
      wanted === undefined
        ? undefined
        : module.actions.find((candidate) => candidate.key === wanted);
    if (action === undefined) continue;
    // An action owns at most one option: taking this one leaves any other it owned ungated.
    Object.assign(action, { sets_choice_field: field.key, sets_choice_option: option });
  }

  const taken = moduleAliases(module);
  const key =
    existing?.key ??
    unique(nameFrom(name), new Set(record.pipelines.map((pipeline) => pipeline.key)), 40);
  if (!builderKeySchema.safeParse(key).success)
    return {
      kind: "invalid",
      issues: ["Name: start the name with a letter, such as Asset lifecycle."],
    };
  const pipeline: Pipeline = {
    id: existing?.id ?? unique(`pipe_${record.key}_${key}`, taken, 150),
    key,
    name,
    stage_field: field.key,
    stages: stages.map((stage) => ({ option: stage.option, tone: stage.tone })),
    transitions: transitions.map((move) => ({ from: move.from, to: move.to })),
  } as Pipeline;
  const pipelines = record.pipelines as Pipeline[];
  if (existing === undefined) pipelines.push(pipeline);
  else pipelines[pipelines.indexOf(existing)] = pipeline;
  return parsed(source, key);
};

/**
 * The Application source without one pipeline. It is refused while a board shows its choice field,
 * because a board takes its columns and moves from it. Its gates stay with their actions.
 */
export const deleteInlinePipeline = (
  current: ApplicationSourceDocument,
  moduleKey: string,
  recordKey: string,
  pipelineKey: string,
): InlinePipelineResult => {
  const references = applicationUses(current, { kind: "pipeline", moduleKey, recordKey, pipelineKey });
  if (references.length > 0)
    return {
      kind: "referenced",
      references,
      issue: `A board shows it in ${references.length === 1 ? "one place" : `${references.length} places`}. Remove those boards, or change the field they group by, first.`,
    };
  const source = structuredClone(current);
  const record = locate(source, moduleKey, recordKey)?.record;
  if (record === undefined || !record.pipelines.some((pipeline) => pipeline.key === pipelineKey))
    return { kind: "invalid", issues: ["This pipeline is not on the record type any more."] };
  (record as { pipelines: Pipeline[] }).pipelines = record.pipelines.filter(
    (pipeline) => pipeline.key !== pipelineKey,
  );
  return parsed(source, pipelineKey);
};

/**
 * Keeps a choice field's pipeline in step with its options after the field editor changed them: a new
 * option becomes the last stage, in the neutral colour role, and a removed option's stage and moves go.
 */
export const syncInlinePipelineStages = (record: RecordType, fieldKey: string): void => {
  const options = choiceOptions(record, fieldKey);
  const pipelines = record.pipelines as Pipeline[];
  const at = pipelines.findIndex((pipeline) => pipeline.stage_field === fieldKey);
  if (at < 0) return;
  if (options === undefined) return;
  const values = options.map((option) => option.value);
  const pipeline = pipelines[at]!;
  pipelines[at] = {
    ...pipeline,
    stages: [
      ...pipeline.stages.filter((stage) => values.includes(stage.option)),
      ...values
        .filter((value) => !pipeline.stages.some((stage) => stage.option === value))
        .map((option) => ({ option, tone: "neutral" as const })),
    ],
    transitions: pipeline.transitions.filter(
      (move) => values.includes(move.from) && values.includes(move.to),
    ),
  };
};
