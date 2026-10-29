import type { FlowPathCondition } from "../workflows/flow-plan";
import type { FlowValue } from "../workflows/flow-values";
import {
  evaluateFlowFormula,
  flowRuntimeValuesEqual,
  type FlowFormulaScope,
  type FlowRuntimeValue,
} from "./flow-formula";

/** Re-evaluates the compiled path without looking up branch tasks in the definition. */
export const flowPathGuardMatches = (
  guard: readonly FlowPathCondition[],
  scope: FlowFormulaScope,
  evaluate: (value: FlowValue, taskId: string) => FlowRuntimeValue,
): boolean =>
  guard.every((condition) => {
    if (condition.kind === "if") {
      const value = evaluateFlowFormula(condition.condition, scope);
      return value?.type === "yes_no" && value.value === (condition.branch === "then");
    }
    const value = evaluate(condition.value, condition.taskId);
    const matches = ("cases" in condition ? condition.cases : [condition.when]).map((literal) =>
      flowRuntimeValuesEqual(value, literal),
    );
    return (
      matches.every((match) => match !== undefined) &&
      ("cases" in condition ? !matches.some(Boolean) : matches[0] === true)
    );
  });
