import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import type { StudioCompileFailure, StudioDataSelection } from "@vortex/ui/studio";

/** Why the saved draft does not compile, in words, and the Data tab item to change when it is one. */
export type StudioCompileProblem = Readonly<{ message: string; selection: StudioDataSelection | null }>;

const fieldAdvice: Readonly<Record<string, string>> = {
  calculation: "Check its formula and its result: for example, money divided by a number gives money.",
  total: "Check the related records, the field it takes and its result.",
  link: "Check the record type it links to.",
  link_to_one_of_several: "Check the record types it links to.",
  choice: "Check its options.",
  several_choices: "Check its options.",
  table: "Check its columns.",
};

const ruleWords = (reasonCode: string): string =>
  reasonCode.replace(/^vortex\.definition\./u, "").replaceAll("_", " ");

/**
 * The compile refusal of the saved draft as a person reads it: the field or query it is about, by
 * its name, with what to check, or the platform's rule in words when it names neither.
 */
export const describeStudioCompileFailure = (failure: StudioCompileFailure, source: ApplicationSourceDocument): StudioCompileProblem => {
  const modules = source.body.modules;
  if (failure.queryKey !== undefined) {
    const module = modules.find((item) => item.key === failure.moduleKey && item.queries.some((query) => query.key === failure.queryKey))
      ?? modules.find((item) => item.queries.some((query) => query.key === failure.queryKey));
    const query = module?.queries.find((item) => item.key === failure.queryKey);
    if (module !== undefined && query !== undefined)
      return { message: `The query ${query.label ?? query.key} can't be used as it is set up. Check its filter, columns, sorting and totals, or remove what does not fit.`,
        selection: { kind: "query", moduleKey: module.key, queryKey: query.key } };
  }
  if (failure.recordTypeKey !== undefined) {
    const holds = (item: (typeof modules)[number]) => item.record_types.some((record) => record.key === failure.recordTypeKey &&
      (failure.fieldKey === undefined || record.fields.some((field) => field.key === failure.fieldKey)));
    const module = modules.find((item) => item.key === failure.moduleKey && holds(item)) ?? modules.find(holds);
    const record = module?.record_types.find((item) => item.key === failure.recordTypeKey);
    const field = failure.fieldKey === undefined ? undefined : record?.fields.find((item) => item.key === failure.fieldKey);
    if (module !== undefined && record !== undefined && field !== undefined)
      return { message: `The field ${field.label} of ${record.plural_name} can't be used as it is set up. ${fieldAdvice[field.type] ?? "Check its settings."} You can also remove it.`,
        selection: { kind: "field", moduleKey: module.key, recordKey: record.key, fieldKey: field.key } };
    if (module !== undefined && record !== undefined)
      return { message: `The record type ${record.plural_name} can't be used as it is set up (${ruleWords(failure.reasonCode)}).`,
        selection: { kind: "record_type", moduleKey: module.key, recordKey: record.key } };
  }
  if (failure.blockAlias !== undefined)
    return { message: `A block on a page can't be used as it is set up (${ruleWords(failure.reasonCode)}, block ${failure.blockAlias}). Change it on the canvas.`, selection: null };
  return { message: `Something in the draft can't be used as it is set up (${ruleWords(failure.reasonCode)}).`, selection: null };
};
