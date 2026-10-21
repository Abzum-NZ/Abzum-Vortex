import type { RecordsTableInlineEditor } from "@vortex/platform/schema";
import type { EditDraft } from "./edit-values";

/**
 * The one reading of a declared field dependency in a cell editor, a row editor and a card: which
 * field a link or choice takes its choices from, which fields depend on a changed field, and what
 * clears. The server owns the rule (it derives the parent from the draft and refuses an
 * inconsistent pair at save); this only keeps the person's draft from offering or keeping a pair it
 * will refuse.
 */
type EditField = Readonly<{ field: string; editor: RecordsTableInlineEditor }>;

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/** The field a link or choice field takes its choices from, when it declares one. */
export const parentFieldOf = (editor: RecordsTableInlineEditor): string | undefined =>
  editor.kind === "link" || editor.kind === "choice" ? editor.dependsOnField : undefined;

/** What an editor holds once cleared: no record for a link, the empty option for a choice. */
export const clearedDraft = (editor: RecordsTableInlineEditor): EditDraft =>
  editor.kind === "link" ? null : "";

/**
 * The options of a dependent choice editor that belong to the parent's chosen option; every option
 * of an editor that depends on nothing.
 */
export const optionsForParent = (
  editor: Extract<RecordsTableInlineEditor, { kind: "choice" }>,
  parentKey: string | undefined,
): Extract<RecordsTableInlineEditor, { kind: "choice" }>["options"] =>
  editor.dependsOnField === undefined
    ? editor.options
    : editor.options.filter(
        (option) => parentKey !== undefined && option.parentValues?.includes(parentKey) === true,
      );

/** The fields that take their choices from `parent`, directly. */
export const dependentFieldsOf = <Field extends EditField>(
  fields: readonly Field[],
  parent: string,
): readonly Field[] =>
  fields.filter((candidate) => {
    const declared = parentFieldOf(candidate.editor);
    return declared !== undefined && same(declared, parent);
  });

/**
 * What a stored value chooses for a dependent field: the record a link names or the option a choice
 * holds, or undefined while the field is empty or withheld.
 */
export const storedChoiceKey = (stored: unknown): string | undefined =>
  typeof stored === "string" && stored !== ""
    ? stored
    : typeof stored === "object" &&
        stored !== null &&
        typeof (stored as Record<string, unknown>).recordId === "string"
      ? (stored as Record<string, string>).recordId
      : undefined;

/** What a draft chooses for a dependent field, or undefined while it is empty. */
export const draftChoiceKey = (draft: EditDraft | undefined): string | undefined =>
  typeof draft === "string"
    ? draft === ""
      ? undefined
      : draft
    : typeof draft === "object" && draft !== null
      ? draft.recordId
      : undefined;

/**
 * Every field that depends on `changed`, directly or through another dependent, and whose draft
 * holds a value: those clear when `changed` changes, so a pair the server would refuse is never
 * kept in the draft.
 */
export const dependentsToClear = <Field extends EditField & Readonly<{ draft: EditDraft }>>(
  fields: readonly Field[],
  changed: string,
): readonly Field[] => {
  const cleared: Field[] = [];
  const queue = [changed];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of dependentFieldsOf(fields, parent)) {
      if (cleared.some((entry) => same(entry.field, child.field))) continue;
      queue.push(child.field);
      if (draftChoiceKey(child.draft) !== undefined) cleared.push(child);
    }
  }
  return cleared;
};
