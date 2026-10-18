import {
  compareExactDecimals,
  compileTextInputPattern,
  moduleFieldValueSchemas,
  parseExactDecimal,
  type ActionInputDefinition,
  type DefinitionRuleFailure,
  type RecordsTableContract,
} from "../schema";

/** Publication checks the exact Module inputs; the protected Query engine still validates values. */
export function tableQueryParameterFailures(
  table: RecordsTableContract,
  inputs: readonly ActionInputDefinition[],
): DefinitionRuleFailure["family"][] {
  const failures: DefinitionRuleFailure["family"][] = [];
  const declared = new Map(inputs.map((input) => [input.key, input]));
  const supplied = new Set<string>();
  const pageConversions = new Map<string, "whole_number" | "yes_no" | "string">();
  for (const parameter of table.parameters) {
    if (supplied.has(parameter.input)) failures.push("duplicate_key");
    supplied.add(parameter.input);
    const input = declared.get(parameter.input);
    if (input === undefined) {
      failures.push("unknown_property");
      continue;
    }
    // The table's page adapter converts whole-number and yes/no scalars and a record id into a reference to
    // the input's one declared record type. Neither adapter accepts other structured values or
    // identity inputs; fixed settings reach the engine as text unchanged.
    const pageReference =
      parameter.source === "page" &&
      input.type === "record_reference" &&
      input.recordTypes.length === 1;
    if (
      !["text", "decimal_number", "date", "date_time"].includes(input.type) &&
      !(parameter.source === "page" && ["whole_number", "yes_no"].includes(input.type)) &&
      !pageReference
    ) {
      failures.push("unsupported_choice");
      continue;
    }
    if (parameter.pageParameter !== undefined) {
      // Web writes every declared alias, including aliases on fixed-source parameters.
      const conversion =
        input.type === "whole_number" ? "whole_number" : input.type === "yes_no" ? "yes_no" : "string";
      const previous = pageConversions.get(parameter.pageParameter);
      if (previous !== undefined && previous !== conversion) failures.push("unsupported_choice");
      pageConversions.set(parameter.pageParameter, conversion);
    }
    if (parameter.source === "page") {
      if (parameter.pageParameter === undefined) failures.push("required_value");
      continue;
    }
    const value = parameter.fixedValue;
    if (value === undefined) {
      failures.push("required_value");
      continue;
    }
    let valid = true;
    if (input.type === "text") {
      const validation = input.validation;
      const pattern =
        validation?.pattern === undefined ? undefined : compileTextInputPattern(validation.pattern);
      valid =
        (validation?.minimumLength === undefined || value.length >= validation.minimumLength) &&
        (validation?.maximumLength === undefined || value.length <= validation.maximumLength) &&
        (validation?.pattern === undefined || (pattern !== undefined && pattern.test(value)));
    } else if (input.type === "decimal_number") {
      const decimal = parseExactDecimal(value);
      const minimum =
        input.validation?.minimum === undefined
          ? undefined
          : parseExactDecimal(input.validation.minimum);
      const maximum =
        input.validation?.maximum === undefined
          ? undefined
          : parseExactDecimal(input.validation.maximum);
      valid =
        decimal !== undefined &&
        (minimum === undefined || compareExactDecimals(decimal, minimum) >= 0) &&
        (maximum === undefined || compareExactDecimals(decimal, maximum) <= 0);
    } else if (input.type === "date" || input.type === "date_time") {
      const comparable = input.type === "date" ? value : Date.parse(value);
      const bound = (candidate: string) =>
        input.type === "date" ? candidate : Date.parse(candidate);
      valid =
        moduleFieldValueSchemas[input.type].safeParse(value).success &&
        (input.validation?.earliest === undefined ||
          comparable >= bound(input.validation.earliest)) &&
        (input.validation?.latest === undefined || comparable <= bound(input.validation.latest));
    }
    if (!valid) failures.push("invalid_value");
  }
  for (const input of inputs)
    if (input.required && !supplied.has(input.key)) failures.push("required_value");
  return failures;
}
