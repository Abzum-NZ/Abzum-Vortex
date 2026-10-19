import {
  isPageParameterName,
  type QueryBinding,
  type QueryBindings,
  type QueryBindingSource,
} from "./query-bindings";
import {
  parseQueryBindingText,
  queryBindingTypeName,
  queryBindingTypesFit,
  withArticle,
  type QueryBindingValueType,
} from "./query-binding-values";

/** One input of the bound query, as both Studio and publication know it. */
export type QueryBindingInput = Readonly<{
  key: string;
  label: string;
  /** Undefined for an input type no binding can fill. */
  type: QueryBindingValueType | undefined;
  required: boolean;
}>;

/** A record field a binding may name: of the page's subject, or of the row of a row panel. */
export type QueryBindingField = Readonly<{
  field: string;
  label: string;
  /** Undefined for a field whose values no query input can hold. */
  type: QueryBindingValueType | undefined;
}>;

/** One parameter the page declares: its subject, or the one a control publishes. */
export type QueryBindingPageParameter = Readonly<{
  name: string;
  type: QueryBindingValueType;
  /** The control that publishes it, as the binding names the control; absent for the subject. */
  control?: string;
}>;

/** One control on the page, by the placement a binding names, with its label. */
export type QueryBindingControl = Readonly<{
  placement: string;
  label: string;
  /** The page parameter it publishes; absent when it publishes none. */
  parameter?: string;
}>;

/**
 * What the page offers the bindings of one block. Studio builds it from the draft and publication
 * from the compiled release; the check is the same function for both, so it says the same sentence.
 */
export type QueryBindingPageFacts = Readonly<{
  /** The block's name in sentences: its authored title, or its kind. */
  blockLabel: string;
  parameters: readonly QueryBindingPageParameter[];
  controls: readonly QueryBindingControl[];
  /** The fields of the page's subject record; undefined when the page is not a record page. */
  recordFields: readonly QueryBindingField[] | undefined;
  /** The fields of the parent row; undefined anywhere but a row's related records. */
  rowFields: readonly QueryBindingField[] | undefined;
  /** The parent row's record type, inside a row's related records. */
  rowRecordType?: string;
  recordTypeLabel: (recordType: string) => string;
}>;

/** One binding problem: the business sentence, and the input it is about when there is one. */
export type QueryBindingProblem = Readonly<{ input?: string; sentence: string }>;

type SourceFacts =
  | Readonly<{
      kind: "typed";
      type: QueryBindingValueType | undefined;
      description: string;
      field?: string;
    }>
  | Readonly<{ kind: "problem"; sentence: string }>
  | Readonly<{ kind: "fixed"; value: string }>;

const sourceFacts = (source: QueryBindingSource, facts: QueryBindingPageFacts): SourceFacts => {
  switch (source.kind) {
    case "fixed":
      return { kind: "fixed", value: source.value };
    case "page_parameter": {
      const parameter = facts.parameters.find((candidate) => candidate.name === source.name);
      return parameter === undefined
        ? { kind: "problem", sentence: `This page has no parameter called ${source.name}.` }
        : {
            kind: "typed",
            type: parameter.type,
            description: `the page parameter ${source.name}`,
          };
    }
    case "control": {
      const control = facts.controls.find(
        (candidate) => candidate.placement.toLowerCase() === source.placement.toLowerCase(),
      );
      if (control === undefined)
        return { kind: "problem", sentence: `${source.placement} is not on this page.` };
      const parameter = facts.parameters.find((candidate) => candidate.name === control.parameter);
      return control.parameter === undefined || parameter === undefined
        ? { kind: "problem", sentence: `${control.label} publishes no page parameter.` }
        : { kind: "typed", type: parameter.type, description: control.label };
    }
    case "record_field": {
      if (facts.recordFields === undefined)
        return { kind: "problem", sentence: "Record fields can be used only on a record page." };
      const field = facts.recordFields.find(
        (candidate) => candidate.field.toLowerCase() === source.field.toLowerCase(),
      );
      return field === undefined
        ? { kind: "problem", sentence: "This page's record has no such field." }
        : { kind: "typed", type: field.type, description: field.label, field: field.label };
    }
    case "current_person":
      return { kind: "typed", type: { kind: "person" }, description: "the current person" };
    case "relative_date":
      return { kind: "typed", type: { kind: "date" }, description: "a relative date" };
    case "this_row": {
      if (facts.rowFields === undefined || facts.rowRecordType === undefined)
        return {
          kind: "problem",
          sentence: "This row can be used only inside a row's related records.",
        };
      if (source.field === undefined)
        return {
          kind: "typed",
          type: { kind: "record", recordTypes: [facts.rowRecordType] },
          description: "this row",
        };
      const field = facts.rowFields.find(
        (candidate) => candidate.field.toLowerCase() === source.field!.toLowerCase(),
      );
      return field === undefined
        ? { kind: "problem", sentence: "This row has no such field." }
        : { kind: "typed", type: field.type, description: field.label, field: field.label };
    }
  }
};

const bindingProblem = (
  binding: QueryBinding,
  input: QueryBindingInput,
  facts: QueryBindingPageFacts,
): string | undefined => {
  const name = (type: QueryBindingValueType): string =>
    queryBindingTypeName(type, facts.recordTypeLabel);
  if (input.type === undefined) return `${input.label} cannot take a value from a binding.`;
  const source = sourceFacts(binding.source, facts);
  if (source.kind === "problem") return source.sentence;
  if (source.kind === "fixed")
    return parseQueryBindingText(source.value, input.type) === undefined
      ? `${source.value} is not a valid ${name(input.type)} for ${input.label}.`
      : undefined;
  if (source.type === undefined)
    return `${input.label} needs ${withArticle(name(input.type))}; ${source.description} gives no value a query can use.`;
  if (queryBindingTypesFit(input.type, source.type, binding.source.kind === "relative_date"))
    return undefined;
  if (input.type.kind === "record" && source.type.kind === "record" && source.field !== undefined)
    return `${input.label} needs ${withArticle(name(input.type))}; ${source.field} links to ${name(source.type)}.`;
  return `${input.label} needs ${withArticle(name(input.type))}; ${source.description} gives ${withArticle(name(source.type))}.`;
};

/**
 * The one binding check: every required input bound, each binding naming a declared input once,
 * and each source existing on this page and giving a value of the input's type. Studio shows each
 * sentence beside its input; publication refuses with the same sentences.
 */
export const checkQueryBindings = (
  bindings: QueryBindings,
  inputs: readonly QueryBindingInput[],
  facts: QueryBindingPageFacts,
): readonly QueryBindingProblem[] => {
  const problems: QueryBindingProblem[] = [];
  const bound = new Set<string>();
  for (const binding of bindings) {
    const input = inputs.find((candidate) => candidate.key === binding.input);
    if (input === undefined) {
      problems.push({ sentence: `${facts.blockLabel} has no input called ${binding.input}.` });
      continue;
    }
    if (bound.has(input.key)) {
      problems.push({ input: input.key, sentence: `${input.label} has two sources.` });
      continue;
    }
    bound.add(input.key);
    const sentence = bindingProblem(binding, input, facts);
    if (sentence !== undefined) problems.push({ input: input.key, sentence });
  }
  for (const input of inputs)
    if (input.required && !bound.has(input.key))
      problems.push({
        input: input.key,
        sentence: `${facts.blockLabel} needs a value for ${input.label}.`,
      });
  return problems;
};

/**
 * The page-level check of declared parameters: each control's name is a valid parameter name and
 * no two controls publish the same one.
 */
export const checkPageParameters = (
  controls: readonly QueryBindingControl[],
): readonly QueryBindingProblem[] => {
  const problems: QueryBindingProblem[] = [];
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const control of controls) {
    const name = control.parameter;
    if (name === undefined) continue;
    if (!isPageParameterName(name)) {
      problems.push({ sentence: `${name} cannot be a page parameter name.` });
      continue;
    }
    if (seen.has(name) && !reported.has(name)) {
      problems.push({ sentence: `Two controls on this page publish ${name}.` });
      reported.add(name);
    }
    seen.add(name);
  }
  return problems;
};
