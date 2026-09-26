export const typedConditionEvaluationErrorReasons = [
  "input_refused",
  "field_refused",
  "parameter_refused",
  "operator_refused",
] as const;

export type TypedConditionEvaluationErrorReason =
  (typeof typedConditionEvaluationErrorReasons)[number];

export class TypedConditionEvaluationError extends Error {
  constructor(readonly reason: TypedConditionEvaluationErrorReason) {
    super(`vortex.rule.typed_condition_${reason}`);
    this.name = "TypedConditionEvaluationError";
  }
}
