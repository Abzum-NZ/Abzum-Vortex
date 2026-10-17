import { z } from "zod";
import { labelSchema } from "../catalogue/common";
import { builderKeySchema, fieldIdSchema, pipelineIdSchema } from "../catalogue/identifiers";

/**
 * A record type's pipeline: the lifecycle of one of its choice fields. Its stages are that field's
 * options, each exactly once, in the order a board shows them, each with a colour role from the
 * theme. Its transitions are the only moves between two stages a save accepts; a stage whose option
 * a named action owns is gated by that action (the action model, not the pipeline, says so).
 */

/** The theme colour roles a stage may take; each names a theme token, never a colour value. */
export const pipelineStageTones = [
  "neutral",
  "primary",
  "destructive",
  "chart_1",
  "chart_2",
  "chart_3",
  "chart_4",
  "chart_5",
] as const;
export const pipelineStageToneSchema = z.enum(pipelineStageTones);
export type PipelineStageTone = z.infer<typeof pipelineStageToneSchema>;

export const maximumRecordTypePipelines = 10;
export const maximumPipelineStages = 200;
export const maximumPipelineTransitions = 1_000;

const optionValueSchema = z.string().min(1).max(120);

export const pipelineStageSchema = z
  .object({ option: optionValueSchema, tone: pipelineStageToneSchema })
  .strict();
export const pipelineTransitionSchema = z
  .object({ from: optionValueSchema, to: optionValueSchema })
  .strict();

export const recordTypePipelineSchema = z
  .object({
    pipelineId: pipelineIdSchema,
    key: builderKeySchema,
    name: labelSchema,
    stageFieldId: fieldIdSchema,
    stages: z.array(pipelineStageSchema).min(1).max(maximumPipelineStages),
    transitions: z.array(pipelineTransitionSchema).max(maximumPipelineTransitions),
  })
  .strict();
export type RecordTypePipeline = z.infer<typeof recordTypePipelineSchema>;

type PipelineShape = Readonly<{
  stages: readonly Readonly<{ option: string }>[];
  transitions: readonly Readonly<{ from: string; to: string }>[];
}>;

export type PipelineShapeProblem = Readonly<{ path: (string | number)[]; message: string }>;

/**
 * Why a pipeline does not fit the options of its stage field: every option is one stage, and every
 * transition joins two different stages once. `options` is undefined when the stage field is not a
 * choice field of the record type.
 */
export const pipelineShapeProblems = (
  pipeline: PipelineShape,
  options: readonly string[] | undefined,
): PipelineShapeProblem[] => {
  if (options === undefined)
    return [{ path: [], message: "A pipeline follows one choice field of its record type" }];
  const problems: PipelineShapeProblem[] = [];
  const stages = new Set<string>();
  for (const [index, stage] of pipeline.stages.entries()) {
    if (stages.has(stage.option))
      problems.push({ path: ["stages", index], message: "Each option is one stage, once" });
    else if (!options.includes(stage.option))
      problems.push({ path: ["stages", index], message: "A stage must be an option of the field" });
    stages.add(stage.option);
  }
  if (options.some((option) => !stages.has(option)))
    problems.push({ path: ["stages"], message: "Every option of the field must be a stage" });
  const moves = new Set<string>();
  for (const [index, transition] of pipeline.transitions.entries()) {
    const move = JSON.stringify([transition.from, transition.to]);
    if (!stages.has(transition.from) || !stages.has(transition.to))
      problems.push({ path: ["transitions", index], message: "A transition joins two stages" });
    else if (transition.from === transition.to)
      problems.push({
        path: ["transitions", index],
        message: "A transition moves to another stage",
      });
    else if (moves.has(move))
      problems.push({ path: ["transitions", index], message: "Each transition is declared once" });
    moves.add(move);
  }
  return problems;
};

/** The stages a record may move to from one stage, in stage order. */
export const pipelineMovesFrom = (pipeline: PipelineShape, from: string): string[] =>
  pipeline.stages
    .map((stage) => stage.option)
    .filter((to) =>
      pipeline.transitions.some((transition) => transition.from === from && transition.to === to),
    );

/**
 * Whether a save may change the stage field from one value to another. Staying in a stage is no
 * move; a record that has no stage yet, or leaves every stage, is outside the pipeline's moves.
 */
export const pipelineAllowsMove = (
  pipeline: PipelineShape,
  from: string | undefined,
  to: string | undefined,
): boolean =>
  from === undefined ||
  to === undefined ||
  from === to ||
  pipeline.transitions.some((transition) => transition.from === from && transition.to === to);

const joined = (labels: readonly string[]): string =>
  labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}`;

/**
 * The plain-English refusal of a move the pipeline does not allow. It names only the field's and
 * the options' labels, never a record value beyond the two stages the person chose between.
 */
export const pipelineMoveRefusalMessage = (
  pipeline: PipelineShape,
  fieldLabel: string,
  optionLabel: (option: string) => string,
  from: string,
  to: string,
): string => {
  const next = pipelineMovesFrom(pipeline, from).map(optionLabel);
  return (
    `${fieldLabel} can't move from ${optionLabel(from)} to ${optionLabel(to)}. ` +
    (next.length === 0
      ? `Nothing moves on from ${optionLabel(from)}.`
      : `From ${optionLabel(from)} it can move to ${joined(next)}.`)
  );
};
