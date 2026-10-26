import { savedSharingConditionSchema } from "../module-contracts";
import type { ModuleField } from "../module-field-contracts";
import type { ConditionNode } from "../module-foundation-contracts";
import {
  evaluateTypedCondition,
  type TypedConditionParameterDeclaration,
} from "../../rules/typed-condition";
import { TypedConditionEvaluationError } from "../../rules/typed-condition-error";
import { DefinitionCompilationError } from "../compilation-error";
import { object } from "./helpers";

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
