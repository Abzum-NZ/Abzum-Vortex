import type {
  DefinitionValidationLocation,
  DefinitionRuleFailure,
} from "../../catalogue/validation-errors";
import type { Output, JsonObject, DefinitionPath } from "./context";

export const rootLocation = (output: Output): DefinitionValidationLocation => {
  const canonical = output.canonical as unknown as JsonObject;
  const envelope = canonical.envelope as JsonObject | undefined;
  const key = String(envelope?.key ?? canonical.key);
  const kind =
    output.kind === "module"
      ? ("module" as const)
      : output.kind === "application"
        ? ("application" as const)
        : ("connection" as const);
  return {
    documentKind: output.kind,
    documentKey: key,
    segments: [{ kind, key }],
  };
};

export const failure = (
  output: Output,
  ruleCode: string,
  family: DefinitionRuleFailure["family"],
  component?: DefinitionValidationLocation["segments"][number],
  /** A rule with its own business sentence names its catalogue code; others use the family's. */
  code?: DefinitionRuleFailure["code"],
  /** The sentence that names this failure's parts, for a rule whose sentence is not fixed. */
  sentence?: string,
): DefinitionRuleFailure => ({
  ruleCode,
  family,
  ...(code === undefined ? {} : { code }),
  ...(sentence === undefined ? {} : { sentence }),
  location: component
    ? { ...rootLocation(output), segments: [...rootLocation(output).segments, component] }
    : rootLocation(output),
});

export const object = (value: unknown) => value as JsonObject;

export const array = (value: unknown) => value as JsonObject[];

export const pathKey = (path: DefinitionPath) => JSON.stringify(path);

export const outputKey = (output: Output) => {
  const canonical = object(output.canonical);
  return String(object(canonical.envelope ?? canonical).key);
};
