import {
  compareExactDecimals,
  exactDecimalDigitCounts,
  normalizeExactDecimal,
  parseExactDecimal,
  type JsonValue,
  type RecordsTableInlineEditor,
} from "@vortex/platform/schema";
import { toLocalInputValue, toStoredInstant } from "../../controls/date-time-zone";

/**
 * The one reader and writer of a cell's edit value. A cell never edits what it displays: it starts
 * from the stored value the server sent for the field (`row.edit`), is drafted as the text, choice or
 * switch its control holds, and is written back in the field's own contract (an exact decimal as
 * canonical text, a date as an ISO date, a date-time as an instant, a choice as its option value).
 *
 * The checks here only stop obviously wrong input before a request is made. They grant nothing: the
 * protected writer validates every value again against the field, the save rules and the record's
 * revision, and its refusal is what the person is shown.
 */
export type EditDraft = string | boolean;

export type EditReading =
  Readonly<{ ok: true; value: JsonValue }> | Readonly<{ ok: false; message: string }>;

const WHOLE_NUMBER = /^-?\d{1,15}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const isRealDate = (text: string): boolean => {
  const match = ISO_DATE.exec(text);
  if (match === null) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
};

/** The draft a control starts with for a stored value; an empty value starts an empty draft. */
export const startEditDraft = (
  editor: RecordsTableInlineEditor,
  stored: JsonValue | undefined,
  timeZone: string,
): EditDraft => {
  switch (editor.kind) {
    case "yes_no":
      return stored === true;
    case "whole_number":
      return typeof stored === "number" ? String(stored) : "";
    case "date_time":
      return typeof stored === "string" ? toLocalInputValue(stored, timeZone) : "";
    default:
      return typeof stored === "string" ? stored : "";
  }
};

/**
 * Reads a draft into the value to commit, or says in a sentence why it cannot be. An empty draft
 * clears an optional field (null) and is refused for a required one.
 */
export const readEditDraft = (
  editor: RecordsTableInlineEditor,
  draft: EditDraft,
  label: string,
  timeZone: string,
): EditReading => {
  const fail = (message: string): EditReading => ({ ok: false, message });
  if (editor.kind === "yes_no")
    return typeof draft === "boolean" ? { ok: true, value: draft } : fail(`Choose ${label}.`);
  if (typeof draft !== "string") return fail(`Enter ${label}.`);
  const text = editor.kind === "text" && editor.input === "long_text" ? draft : draft.trim();
  if (text.length === 0)
    return editor.required ? fail(`${label} is required.`) : { ok: true, value: null };
  switch (editor.kind) {
    case "text":
      return editor.maxLength !== undefined && text.length > editor.maxLength
        ? fail(`${label} can have at most ${editor.maxLength} characters.`)
        : { ok: true, value: text };
    case "whole_number": {
      if (!WHOLE_NUMBER.test(text)) return fail(`${label} must be a whole number.`);
      const value = Number(text);
      if (editor.minimum !== undefined && value < editor.minimum)
        return fail(`${label} must be at least ${editor.minimum}.`);
      if (editor.maximum !== undefined && value > editor.maximum)
        return fail(`${label} must be at most ${editor.maximum}.`);
      if (editor.step !== undefined && (value - (editor.minimum ?? 0)) % editor.step !== 0)
        return fail(`${label} must go up in steps of ${editor.step}.`);
      return { ok: true, value };
    }
    case "decimal": {
      const parsed = parseExactDecimal(text);
      if (parsed === undefined) return fail(`${label} must be a number such as 12.50.`);
      const counts = exactDecimalDigitCounts(parsed);
      if (
        counts.digitsBeforeDecimal > editor.digitsBeforeDecimal ||
        counts.decimalPlaces > editor.decimalPlaces
      )
        return fail(
          `${label} can have at most ${editor.digitsBeforeDecimal} digits before the decimal point and ${editor.decimalPlaces} after it.`,
        );
      const minimum = editor.minimum === undefined ? undefined : parseExactDecimal(editor.minimum);
      const maximum = editor.maximum === undefined ? undefined : parseExactDecimal(editor.maximum);
      if (minimum !== undefined && compareExactDecimals(parsed, minimum) < 0)
        return fail(`${label} must be at least ${editor.minimum}.`);
      if (maximum !== undefined && compareExactDecimals(parsed, maximum) > 0)
        return fail(`${label} must be at most ${editor.maximum}.`);
      const canonical = normalizeExactDecimal(text);
      return canonical === undefined
        ? fail(`${label} must be a number.`)
        : { ok: true, value: canonical };
    }
    case "choice":
      return editor.options.some((option) => option.value === text)
        ? { ok: true, value: text }
        : fail(`Choose one of the offered values for ${label}.`);
    case "date": {
      if (!isRealDate(text)) return fail(`${label} must be a real date.`);
      if (editor.earliest !== undefined && text < editor.earliest)
        return fail(`${label} cannot be before ${editor.earliest}.`);
      if (editor.latest !== undefined && text > editor.latest)
        return fail(`${label} cannot be after ${editor.latest}.`);
      return { ok: true, value: text };
    }
    case "date_time": {
      const instant = toStoredInstant(text, timeZone);
      return instant === undefined
        ? fail(`${label} must be a valid date and time in ${timeZone}.`)
        : { ok: true, value: instant };
    }
    default:
      return fail(`${label} cannot be edited here.`);
  }
};

/** Whether committing would change nothing: the new value is the stored one in the field's own terms. */
export const sameEditValue = (
  editor: RecordsTableInlineEditor,
  stored: JsonValue | undefined,
  next: JsonValue,
): boolean => {
  const current = stored ?? null;
  if (editor.kind === "decimal")
    return (
      typeof current === "string" &&
      typeof next === "string" &&
      normalizeExactDecimal(current) === normalizeExactDecimal(next)
    );
  if (editor.kind === "date_time")
    return (
      typeof current === "string" &&
      typeof next === "string" &&
      Date.parse(current) === Date.parse(next)
    );
  return current === next;
};
