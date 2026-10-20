import {
  isPageParameterName,
  PAGE_SUBJECT_PARAMETER,
  type QueryBinding,
  type QueryBindingsRead,
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
  /** The parameter in business words: "This Company", or the publishing control's label. */
  label: string;
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
  /** The directory person type in the caller's identity space; absent without the directory. */
  currentPersonRecordType: string | undefined;
  parameters: readonly QueryBindingPageParameter[];
  controls: readonly QueryBindingControl[];
  /** The fields of the page's subject record; undefined when the page is not a record page. */
  recordFields: readonly QueryBindingField[] | undefined;
  /** The fields of the parent row; undefined anywhere but a row's related records. */
  rowFields: readonly QueryBindingField[] | undefined;
  /** The parent row's record type, inside a row's related records. */
  rowRecordType?: string;
  recordTypeLabel: (recordType: string) => string;
  /** The page's own problems: a control that cannot publish, or a name two controls publish. */
  pageProblems: readonly QueryBindingProblem[];
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
      if (parameter === undefined)
        return { kind: "problem", sentence: `This page has no parameter called ${source.name}.` };
      // A control's value is bound through the control: the one way to name it.
      if (parameter.control !== undefined)
        return { kind: "problem", sentence: `Choose ${parameter.label} as the source instead.` };
      return { kind: "typed", type: parameter.type, description: parameter.label };
    }
    case "control": {
      const control = facts.controls.find(
        (candidate) => candidate.placement.toLowerCase() === source.placement.toLowerCase(),
      );
      if (control === undefined)
        return { kind: "problem", sentence: "The chosen control is not on this page." };
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
      return facts.currentPersonRecordType === undefined
        ? { kind: "problem", sentence: "Current person needs the people directory." }
        : {
            kind: "typed",
            type: { kind: "record", recordTypes: [facts.currentPersonRecordType] },
            description: "the current person",
          };
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
    return source.value.trim() === ""
      ? `Write a value for ${input.label}.`
      : parseQueryBindingText(source.value, input.type) === undefined
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
  read: QueryBindingsRead,
  inputs: readonly QueryBindingInput[],
  facts: QueryBindingPageFacts,
): readonly QueryBindingProblem[] => {
  if (read.kind === "malformed")
    return [{ sentence: `${facts.blockLabel} has an input binding without its source.` }];
  const problems: QueryBindingProblem[] = [];
  const bound = new Set<string>();
  for (const binding of read.bindings) {
    const input = inputs.find((candidate) => candidate.key === binding.input);
    if (input === undefined) {
      problems.push({
        sentence: `${facts.blockLabel} has a source for an input its query does not have.`,
      });
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

/** One placement of a page as a binding sees it: its block, its name and what it may publish. */
export type QueryBindingPlacement = Readonly<{
  placement: string;
  blockKey: string | undefined;
  /** The authored label or title; the block's name stands in when there is none. */
  label: string | undefined;
  blockName: string;
  parameter: string | undefined;
  /** The record types a link input names. */
  linkTargets: readonly string[];
  /** The value type of a field input's field. */
  fieldType: QueryBindingValueType | undefined;
  /** The record type of a table that selects a record on click; undefined for any other table. */
  selectedRecordType: string | undefined;
}>;

type Published =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "control"; type: QueryBindingValueType | undefined }>;

/** Whether a placement is a control and the value it publishes: the one rule for both sides. */
const publishedBy = (placement: QueryBindingPlacement): Published => {
  switch (placement.blockKey) {
    case "platform.form.link_input":
      return { kind: "control", type: { kind: "record", recordTypes: placement.linkTargets } };
    case "platform.form.field_input":
      // A field input publishes the record its link field holds; its form owns any other value.
      return {
        kind: "control",
        type: placement.fieldType?.kind === "record" ? placement.fieldType : undefined,
      };
    case "platform.form.text_input":
    case "platform.form.choice_input":
      return { kind: "control", type: { kind: "text" } };
    case "platform.form.date_input":
      return { kind: "control", type: { kind: "date" } };
    case "platform.display.table":
      return placement.selectedRecordType === undefined
        ? { kind: "none" }
        : {
            kind: "control",
            type: { kind: "record", recordTypes: [placement.selectedRecordType] },
          };
    default:
      return { kind: "none" };
  }
};

/**
 * What one page offers the bindings of its blocks, built by this one function from a Studio draft
 * and from a compiled release: the subject parameter of a record page, each control's published
 * parameter typed by the control, the subject record's fields, and the page's own problems (a block
 * that cannot publish, a name that is not a parameter name, a name two controls publish).
 */
export const pageBindingFacts = (
  input: Readonly<{
    /** The record type a record page is about, with its name; undefined on any other page. */
    subject: Readonly<{ recordType: string; label: string }> | undefined;
    currentPersonRecordType: string | undefined;
    placements: readonly QueryBindingPlacement[];
    recordFields: readonly QueryBindingField[] | undefined;
    recordTypeLabel: (recordType: string) => string;
  }>,
): Omit<QueryBindingPageFacts, "blockLabel"> => {
  const parameters: QueryBindingPageParameter[] =
    input.subject === undefined
      ? []
      : [
          {
            name: PAGE_SUBJECT_PARAMETER,
            label: `This ${input.subject.label}`,
            type: { kind: "record", recordTypes: [input.subject.recordType] },
          },
        ];
  const controls: QueryBindingControl[] = [];
  const pageProblems: QueryBindingProblem[] = [];
  const seen = new Set<string>();
  for (const placement of input.placements) {
    const label = placement.label ?? placement.blockName;
    const name = placement.parameter;
    const published = publishedBy(placement);
    if (published.kind === "none") {
      if (name !== undefined)
        pageProblems.push({ sentence: `${label} cannot publish a page parameter.` });
      continue;
    }
    controls.push({
      placement: placement.placement,
      label,
      ...(name === undefined ? {} : { parameter: name }),
    });
    if (name === undefined) continue;
    if (published.type === undefined)
      pageProblems.push({
        sentence: `${label} can publish a page parameter only for a link field.`,
      });
    else if (!isPageParameterName(name))
      pageProblems.push({ sentence: `${name} cannot be a page parameter name.` });
    else if (seen.has(name)) {
      if (!pageProblems.some((problem) => problem.sentence.endsWith(` publish ${name}.`)))
        pageProblems.push({ sentence: `Two controls on this page publish ${name}.` });
    } else {
      seen.add(name);
      parameters.push({ name, label, type: published.type, control: placement.placement });
    }
  }
  return {
    currentPersonRecordType: input.currentPersonRecordType,
    parameters,
    controls,
    recordFields: input.recordFields,
    // No page holds a row's related records yet, so This row is refused everywhere.
    rowFields: undefined,
    recordTypeLabel: input.recordTypeLabel,
    pageProblems,
  };
};
