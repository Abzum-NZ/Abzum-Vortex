import { type ModuleField, type ConditionNode, savedSharingConditionSchema } from "../../schema";
import {
  evaluateTypedCondition,
  type TypedConditionParameterDeclaration,
  TypedConditionEvaluationError,
} from "../../rules/index";
import { DefinitionCompilationError } from "../compilation-error";
import { object } from "./helpers";

export function valueMatchesType(value: unknown, type: string): boolean {
  if (type === "text") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "date") return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function evaluateSavedSharingCondition(
  input: unknown,
  fieldValues: Readonly<Record<string, unknown>>,
  parameters: Readonly<Record<string, unknown>>,
  sourceRecordFields: readonly ModuleField[],
): boolean {
  const candidate = object(input);
  let result: boolean;
  try {
    result = evaluateTypedCondition({
      condition: candidate.condition as ConditionNode,
      sourceRecordFields,
      declaredFieldIds: candidate.declaredFieldIds as string[],
      parameterDeclarations: candidate.parameters as TypedConditionParameterDeclaration[],
      fieldValues,
      parameterValues: parameters,
    });
  } catch (error) {
    if (!(error instanceof TypedConditionEvaluationError)) throw error;
    const mapping = {
      input_refused: "vortex.definition.sharing_condition_input_refused",
      field_refused: "vortex.definition.sharing_condition_field_refused",
      parameter_refused: "vortex.definition.sharing_condition_parameter_refused",
      operator_refused: "vortex.definition.sharing_condition_operator_refused",
    } as const;
    throw new DefinitionCompilationError(
      mapping[error.reason],
      error.reason === "operator_refused" ? "unsupported_choice" : "scope_conflict",
    );
  }
  if (!savedSharingConditionSchema.safeParse(input).success)
    throw new DefinitionCompilationError(
      "vortex.definition.sharing_condition_input_refused",
      "scope_conflict",
    );
  return result;
}
