import { isMoneyValue } from "../records/module-field-value-predicates";
import { flowRoundingModes, type FlowFormula } from "../workflows/flow-formula-tree";
import type { FlowRoundingMode } from "../workflows/flow-values";
import { evaluateFlowFormula, type FlowFormulaScope, type FlowRuntimeValue } from "./flow-formula";
import { flowValueMatchesType } from "./flow-value-shapes";

/** Evaluate the Calculate task with the same exact rounding and output validation on both drivers. */
export const calculateFlowValue = (
  formula: FlowFormula,
  resultType: string,
  places: unknown,
  rounding: unknown,
  scope: FlowFormulaScope,
):
  | Readonly<{ value: FlowRuntimeValue }>
  | Readonly<{ error: "non_integral_whole_number" | "value_unresolved" }> => {
  const precise = resultType === "decimal_number" || resultType === "money";
  if (
    precise &&
    (typeof places !== "number" ||
      typeof rounding !== "string" ||
      !flowRoundingModes.some((mode) => mode === rounding))
  )
    return { error: "value_unresolved" };
  const evaluated = evaluateFlowFormula(
    formula,
    scope,
    precise
      ? { resultScale: places as number, resultRounding: rounding as FlowRoundingMode }
      : { requireExactInteger: resultType === "whole_number" },
  );
  if (evaluated === undefined) {
    if (
      resultType === "whole_number" &&
      evaluateFlowFormula(formula, scope, { resultScale: 18, resultRounding: "half_even" }) !==
        undefined
    )
      return { error: "non_integral_whole_number" };
    return { error: "value_unresolved" };
  }
  const value =
    resultType === "decimal_number" && evaluated.type === "whole_number"
      ? { type: "decimal_number", value: String(evaluated.value) }
      : resultType === "whole_number" && evaluated.type === "decimal_number"
        ? { type: "whole_number", value: Number(evaluated.value) }
        : evaluated;
  return value.type !== resultType ||
    (value.value !== null &&
      !flowValueMatchesType(value.value, resultType) &&
      !(resultType === "money" && isMoneyValue(value.value)))
    ? { error: "value_unresolved" }
    : { value };
};
