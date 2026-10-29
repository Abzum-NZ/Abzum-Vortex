import { flowRuntimeValueOf } from "../rules/flow-runtime-value";
import { checkFlowFormula } from "../rules/flow-formula";
import { flowFormulaChildren, type FlowFormula } from "../workflows/flow-values";

/** Local record references are named while authored and resolved to permanent IDs by compilation. */
export const calculationFormulaDependencies = (formula: FlowFormula): string[] => {
  const found = new Set<string>();
  const visit = (node: FlowFormula): void => {
    if (node.op === "reference") {
      if (node.reference.source === "trigger_record") found.add(node.reference.field);
      if (node.reference.source === "module_field") found.add(node.reference.fieldId);
    }
    flowFormulaChildren(node).forEach(visit);
  };
  visit(formula);
  return [...found];
};

/** Checks a record formula in its source or canonical reference environment. */
export const checkCalculationFormula = (
  formula: FlowFormula,
  fieldType: (key: string) => string | undefined,
  dialect: "source" | "canonical",
): string | undefined => {
  let valid = true;
  const result = checkFlowFormula(formula, {
    nowAllowed: true,
    moneyLiterals: false,
    reference: (reference) => {
      const key =
        dialect === "source" && reference.source === "trigger_record"
          ? reference.field
          : dialect === "canonical" && reference.source === "module_field"
            ? reference.fieldId
            : undefined;
      const type = key === undefined ? undefined : fieldType(key);
      if (type === undefined) valid = false;
      return type === undefined ? undefined : flowRuntimeValueOf(type, null).type;
    },
    issue: () => {
      valid = false;
    },
  });
  return valid ? result : undefined;
};

/** Current read-time storage support is the deadline operator over local fields. */
export const calculationReadTimeSupported = (formula: FlowFormula): boolean =>
  formula.op === "deadline_passed" &&
  formula.due.op === "reference" &&
  (formula.status === undefined || formula.status.op === "reference");
