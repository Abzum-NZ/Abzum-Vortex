import { flowFormulaSchema, type FlowFormula } from "../workflows/flow-values";
import { compileFlowFormula } from "./flow-formula";

/** Prepare the typed formulas of a release, without treating literal data as formula syntax. */
export const prepareFlowFormulas = (input: unknown): void => {
  if (Array.isArray(input)) {
    input.forEach(prepareFlowFormulas);
    return;
  }
  if (input === null || typeof input !== "object") return;
  const record = input as Record<string, unknown>;
  if (record.kind === "literal") return;
  if (typeof record.op === "string" && flowFormulaSchema.safeParse(record).success) {
    compileFlowFormula(record as FlowFormula);
    return;
  }
  Object.values(record).forEach(prepareFlowFormulas);
};
