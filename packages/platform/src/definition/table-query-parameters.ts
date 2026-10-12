import {
  compareExactDecimals,
  compileTextInputPattern,
  moduleFieldValueV2Schemas,
  parseExactDecimal,
  type ActionInputDefinitionV3,
  type DefinitionRuleFailure,
  type RecordsTableContract,
} from "@vortex/contracts";

/** Publication checks the exact Module inputs; the protected Query engine still validates values. */
export function tableQueryParameterFailures(
  table: RecordsTableContract,
  inputs: readonly ActionInputDefinitionV3[],
): DefinitionRuleFailure["family"][] {
  const failures: DefinitionRuleFailure["family"][] = [];
  const declared = new Map(inputs.map((input) => [input.key, input]));
  const supplied = new Set<string>();
  const pageConversions = new Map<string, "number" | "boolean" | "string">();
  for (const parameter of table.parameters) {
    if (supplied.has(parameter.input)) failures.push("duplicate_key");
    supplied.add(parameter.input);
    const input = declared.get(parameter.input);
    if (input === undefined) {
      failures.push("unknown_property");
      continue;
    }
    // The table's page adapter converts only number/boolean scalars. Neither adapter accepts
    // structured values or identity inputs; fixed settings reach the engine as text unchanged.
    if (
      !["text", "decimal_number", "date", "date_time"].includes(input.type) &&
      !(parameter.source === "page" && ["number", "boolean"].includes(input.type))
    ) {
      failures.push("unsupported_choice");
      continue;
    }
    if (parameter.pageParameter !== undefined) {
      // Web writes every declared alias, including aliases on fixed-source parameters.
      const conversion =
        input.type === "number" ? "number" : input.type === "boolean" ? "boolean" : "string";
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
        moduleFieldValueV2Schemas[input.type].safeParse(value).success &&
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
