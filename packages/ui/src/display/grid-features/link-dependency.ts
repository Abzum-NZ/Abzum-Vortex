import type { RecordsTableInlineEditor } from "@vortex/platform/schema";
import type { EditDraft } from "./edit-values";

/**
 * The one reading of a declared link dependency in a cell editor, a row editor and a card: which
 * field a link takes its choices from, which fields depend on a changed field, and what clears.
 * The server owns the rule (it derives the parent from the draft and refuses an inconsistent pair
 * at save); this only keeps the person's draft from offering or keeping a pair it will refuse.
 */
type EditField = Readonly<{ field: string; editor: RecordsTableInlineEditor }>;

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/** The field a link field takes its choices from, when it declares one. */
export const parentFieldOf = (editor: RecordsTableInlineEditor): string | undefined =>
  editor.kind === "link" ? editor.dependsOnField : undefined;

/** The fields that take their choices from `parent`, directly. */
export const dependentFieldsOf = <Field extends EditField>(
  fields: readonly Field[],
  parent: string,
): readonly Field[] =>
  fields.filter((candidate) => {
    const declared = parentFieldOf(candidate.editor);
    return declared !== undefined && same(declared, parent);
  });

/** The record a stored link value names, or undefined while the field is empty or withheld. */
export const storedRecordId = (stored: unknown): string | undefined =>
  typeof stored === "object" &&
  stored !== null &&
  typeof (stored as Record<string, unknown>).recordId === "string"
    ? (stored as Record<string, string>).recordId
    : undefined;

/** The record a link draft holds, or undefined while it is empty. */
export const draftRecordId = (draft: EditDraft | undefined): string | undefined =>
  typeof draft === "object" && draft !== null ? draft.recordId : undefined;

/**
 * Every field that depends on `changed`, directly or through another dependent, and whose draft
 * holds a record: those clear when `changed` changes, so a pair the server would refuse is never
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
      if (draftRecordId(child.draft) !== undefined) cleared.push(child);
    }
  }
  return cleared;
};

/** What a dependent picker shows while its parent is not chosen, in words that name no record. */
export const waitingForParent = (parentLabel: string): string => `Needs ${parentLabel} first`;
