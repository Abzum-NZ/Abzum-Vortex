"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
} from "react";
import {
  flowFieldCorrectionSchema,
  recordsTableRowEditFeature,
  recordsTableRowEditEvent,
  type JsonValue,
  type RecordsTableInlineEditor,
} from "@vortex/platform/schema";
import { Button } from "../../components/button";
import { Label } from "../../components/label";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/popover";
import { useUnsavedWorkRegistry } from "../../controls/unsaved-work";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/tooltip";
import { Icon } from "../../icons/icon";
import { rowName } from "../context";
import { useDateFormatOptions } from "../date-format-context";
import { fail, requireRecord } from "../payload-parse";
import type { DisplayEventHandlers, DisplayRow } from "../projected-data";
import type { RowLine } from "../sub-rows";
import { EditFieldControl } from "./edit-field-control";
import { linkedRecordTitle } from "./record-choice-picker";
import { clearedDraft, dependentsToClear, draftChoiceKey, parentFieldOf } from "./link-dependency";
import {
  readEditDraft,
  sameEditDraft,
  sameEditValue,
  startEditDraft,
  type EditDraft,
} from "./edit-values";
import type {
  GridFeatureCellProps,
  GridFeatureCommandProps,
  GridFeatureModule,
  GridFeatureScopeProps,
} from "./registry";

type FieldDraft = Readonly<{
  field: string;
  label: string;
  editor: RecordsTableInlineEditor;
  stored: JsonValue;
  draft: EditDraft;
}>;
type RowDraft = Readonly<{
  recordId: string;
  revision: number;
  eventId: string;
  timeZone: string;
  fields: readonly FieldDraft[];
}>;
type RowEditing = Readonly<{
  draft: RowDraft | undefined;
  saving: boolean;
  dirty: boolean;
  conflict: boolean;
  message: string | undefined;
  errors: Readonly<Record<string, string>>;
  start: (row: DisplayRow) => void;
  change: (field: string, value: EditDraft) => void;
  cancel: () => void;
  save: () => void;
  reload: () => void;
}>;

const RowEditingContext = createContext<RowEditing | undefined>(undefined);
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/** One scope per table, with one immutable displayed revision for the entire draft. */
function RowEditScope({ context, children, retainRow }: GridFeatureScopeProps): ReactElement {
  const { timeZone } = useDateFormatOptions();
  const [draft, setDraft] = useState<RowDraft | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [conflict, setConflict] = useState(false);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const id = useId();
  const unsaved = useUnsavedWorkRegistry();
  const dirty =
    draft?.fields.some(
      (field) =>
        !sameEditDraft(field.draft, startEditDraft(field.editor, field.stored, draft.timeZone)),
    ) === true;
  const cancel = (): void => {
    if (submitting.current) return;
    setDraft(undefined);
    setErrors({});
    setMessage(undefined);
    setConflict(false);
  };
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    retainRow(draft?.recordId);
    return () => retainRow(undefined);
  }, [draft?.recordId, retainRow]);
  useEffect(() => {
    if (unsaved === undefined || (!dirty && !saving)) return;
    const formId = `row-edit:${id}`;
    const unregister = unsaved.registerForm(
      formId,
      () => cancelRef.current(),
      () => true,
    );
    unsaved.setDirty(formId, true);
    return () => {
      unsaved.setDirty(formId, false);
      unregister();
    };
  }, [unsaved, dirty, saving, id]);

  // A new projection may remove access or the row itself (refresh, filter, search, paging). Forget
  // the entire draft rather than retaining a hidden or withheld value that the toolbar could still
  // submit. A conflict with unchanged access keeps the original draft and revision.
  useEffect(() => {
    if (draft === undefined || saving) return;
    const current = context.lines.find(
      (line): line is Extract<RowLine, { kind: "row" }> =>
        line.kind === "row" && same(line.row.recordId, draft.recordId),
    )?.row;
    const allowed = context.features.rowEdit;
    if (
      current === undefined ||
      allowed === undefined ||
      !current.capabilities?.actions.includes("update") ||
      draft.fields.some(
        (field) =>
          !allowed.fields.some((candidate) => same(candidate.field, field.field)) ||
          !current.capabilities?.changeableFieldIds.some((candidate) =>
            same(candidate, field.field),
          ) ||
          !Object.keys(current.edit ?? {}).some((candidate) => same(candidate, field.field)),
      )
    ) {
      setDraft(undefined);
      setErrors({});
      setConflict(false);
      setMessage("This row can no longer be edited. Your changes were not saved.");
    }
  }, [context.features.rowEdit, context.lines, draft, saving]);

  const start = (row: DisplayRow): void => {
    const feature = context.features.rowEdit;
    if (
      draft !== undefined ||
      submitting.current ||
      feature === undefined ||
      row.revision === undefined ||
      !row.capabilities?.actions.includes("update")
    )
      return;
    const zone = timeZone ?? "UTC";
    const fields = context.columns.flatMap((column): FieldDraft[] => {
      const field = feature.fields.find((entry) => same(entry.field, column.key));
      const key = Object.keys(row.edit ?? {}).find((entry) => same(entry, column.key));
      if (
        field === undefined ||
        key === undefined ||
        !row.capabilities?.changeableFieldIds.some((entry) => same(entry, column.key))
      )
        return [];
      const stored = row.edit![key]!;
      return [
        {
          field: column.key,
          label: column.label,
          editor: field.editor,
          stored,
          draft: startEditDraft(field.editor, stored, zone),
        },
      ];
    });
    if (fields.length === 0) return;
    setErrors({});
    setMessage(undefined);
    setConflict(false);
    setDraft({
      recordId: row.recordId,
      revision: row.revision,
      eventId: feature.eventId,
      timeZone: zone,
      fields,
    });
  };
  const save = async (): Promise<void> => {
    const handler = context.events?.[recordsTableRowEditEvent];
    if (draft === undefined || handler === undefined || submitting.current || conflict) return;
    const values: Record<string, JsonValue> = {};
    const invalid: Record<string, string> = {};
    for (const field of draft.fields) {
      if (sameEditDraft(field.draft, startEditDraft(field.editor, field.stored, draft.timeZone)))
        continue;
      const reading = readEditDraft(field.editor, field.draft, field.label, draft.timeZone);
      if (!reading.ok) invalid[field.field] = reading.message;
      else if (!sameEditValue(field.editor, field.stored, reading.value))
        values[field.field] = reading.value;
    }
    setErrors(invalid);
    if (Object.keys(invalid).length > 0) {
      setMessage("Correct the marked fields. Nothing has been saved.");
      return;
    }
    if (Object.keys(values).length === 0) {
      setMessage("There are no changed values to save.");
      return;
    }
    submitting.current = true;
    setSaving(true);
    setMessage(undefined);
    try {
      const answer = requireRecord(
        await handler({
          event: recordsTableRowEditEvent,
          eventId: draft.eventId,
          recordId: draft.recordId,
          revision: draft.revision,
          values,
          commandId: crypto.randomUUID(),
        }),
        "A row save must return its outcome",
        { propertyPath: [recordsTableRowEditFeature.key] },
      );
      if (!mounted.current) return;
      if (answer.kind === "saved") {
        setDraft(undefined);
        setErrors({});
        setConflict(false);
        setMessage("Row saved.");
      } else if (
        answer.kind === "refused" &&
        typeof answer.message === "string" &&
        typeof answer.changed === "boolean"
      ) {
        setConflict(answer.changed);
        const corrections =
          answer.changed || answer.corrections === undefined
            ? []
            : flowFieldCorrectionSchema.array().parse(answer.corrections);
        const located = corrections.filter((correction) =>
          Object.keys(values).some((field) => same(field, correction.field)),
        );
        const fieldErrors = Object.fromEntries(
          located.map((correction) => [
            Object.keys(values).find((field) => same(field, correction.field))!,
            correction.message ??
              (correction.code === "required_value"
                ? "This field is required."
                : "Check this value."),
          ]),
        );
        const count = Object.keys(fieldErrors).length;
        // Located corrections show at their field; the save controls name how many need fixing and
        // keep any correction for a field this row did not submit.
        const unlocated = [
          ...new Set(
            corrections.flatMap((correction) =>
              located.includes(correction) || correction.message === undefined
                ? []
                : [correction.message],
            ),
          ),
        ];
        setErrors(fieldErrors);
        setMessage(
          count === 0
            ? answer.message
            : [
                `Correct ${count} ${count === 1 ? "field" : "fields"} before saving.`,
                ...unlocated,
              ].join(" "),
        );
      } else
        fail("A row save returned an invalid outcome", {
          propertyPath: [recordsTableRowEditFeature.key],
        });
    } catch (error) {
      console.error("[display] row save failed", error);
      if (mounted.current) {
        setConflict(true);
        setMessage("The save could not be confirmed. Reload the row before trying again.");
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const editing: RowEditing = {
    draft,
    saving,
    dirty,
    conflict,
    message,
    errors,
    start,
    change: (field, value) => {
      if (submitting.current || draft === undefined) return;
      // Fields that take their choices from the changed one clear in the same draft, so the row
      // never carries a pair the server refuses; a required one is then flagged at save.
      const updated = draft.fields.map((entry) =>
        same(entry.field, field) ? { ...entry, draft: value } : entry,
      );
      const cleared = dependentsToClear(updated, field);
      setDraft({
        ...draft,
        fields: updated.map((entry) =>
          cleared.some((dependent) => same(dependent.field, entry.field))
            ? { ...entry, draft: clearedDraft(entry.editor) }
            : entry,
        ),
      });
      setMessage(
        cleared.length === 0
          ? undefined
          : `${cleared.map((entry) => entry.label).join(" and ")} cleared because ${draft.fields.find((entry) => same(entry.field, field))?.label ?? "the field"} changed.`,
      );
    },
    cancel,
    save: () => {
      void save();
    },
    reload: () => {
      cancel();
      void context.events?.refresh?.({ event: "refresh" });
    },
  };
  return (
    <RowEditingContext.Provider value={editing}>
      {children}
      {/* Cards unmount their save controls with the draft; this region stays mounted so the
          outcome is announced, and stays empty while the card's own controls show it. */}
      {context.presentation === "cards" ? (
        <span role="status" aria-live="polite" className="sr-only">
          {draft === undefined ? message : undefined}
        </span>
      ) : null}
    </RowEditingContext.Provider>
  );
}

/** Controls are shadcn primitives; the shared edit-values module owns every type conversion. */
function FieldControl({
  field,
  editing,
  events,
  current,
  inline,
  id: labelledId,
}: Readonly<{
  field: FieldDraft;
  editing: RowEditing;
  events: DisplayEventHandlers | undefined;
  /** The row's title for a stored link, named until another record is chosen. */
  current?: string | undefined;
  /** Laid out on one line inside a grid cell. */
  inline?: boolean;
  id?: string;
}>): ReactElement {
  const ownId = useId();
  const id = labelledId ?? ownId;
  const message = editing.errors[field.field];
  const parentField = parentFieldOf(field.editor);
  const parent =
    parentField === undefined
      ? undefined
      : editing.draft?.fields.find((entry) => same(entry.field, parentField));
  const control = (
    <EditFieldControl
      editor={field.editor}
      fieldId={field.field}
      label={field.label}
      draft={field.draft}
      onChange={(next) => editing.change(field.field, next)}
      disabled={editing.saving}
      invalid={message !== undefined}
      describedBy={message === undefined ? undefined : `${id}-error`}
      id={id}
      events={events}
      current={current}
      inline={inline}
      parent={
        parentField === undefined
          ? undefined
          : {
              choiceKey: draftChoiceKey(parent?.draft),
              label: parent?.label ?? "the field it depends on",
            }
      }
    />
  );
  return (
    <span
      className="block min-w-0"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          editing.cancel();
        }
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          editing.save();
        }
      }}
    >
      <Popover open={message !== undefined}>
        <PopoverTrigger nativeButton={false} render={<span className="block min-w-0" />}>
          {control}
        </PopoverTrigger>
        <PopoverContent align="start" initialFocus={false} finalFocus={false}>
          <span id={`${id}-error`} role="alert" className="text-sm text-destructive">
            {message}
          </span>
        </PopoverContent>
      </Popover>
    </span>
  );
}

function RowCell({ context, row, column, children }: GridFeatureCellProps): ReactElement {
  const editing = useContext(RowEditingContext);
  const field =
    editing?.draft?.recordId === row.recordId
      ? editing.draft.fields.find((entry) => same(entry.field, column.key))
      : undefined;
  return context.presentation === "grid" && editing !== undefined && field !== undefined ? (
    <FieldControl
      field={field}
      editing={editing}
      events={context.events}
      current={linkedRecordTitle(row, column.key)}
      inline
    />
  ) : (
    <>{children}</>
  );
}

function RowCommands({ context, row }: GridFeatureCommandProps): ReactElement | null {
  const editing = useContext(RowEditingContext);
  const available = context.features.rowEdit?.fields.some(
    (field) =>
      context.columns.some((column) => same(column.key, field.field)) &&
      Object.keys(row.edit ?? {}).some((key) => same(key, field.field)) &&
      row.capabilities?.changeableFieldIds.some((key) => same(key, field.field)),
  );
  if (
    editing === undefined ||
    !available ||
    !row.capabilities?.actions.includes("update") ||
    row.revision === undefined ||
    context.events?.[recordsTableRowEditEvent] === undefined
  )
    return null;
  if (editing.draft?.recordId === row.recordId && context.presentation === "grid")
    return <SaveControls editing={editing} />;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Edit row: ${rowName(row, context.columns[0]?.key)}`}
            disabled={editing.draft !== undefined || editing.saving}
            onClick={(event) => {
              event.stopPropagation();
              editing.start(row);
            }}
          />
        }
      >
        <Icon name="pencil" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent>Edit row</TooltipContent>
    </Tooltip>
  );
}

function SaveControls({ editing }: Readonly<{ editing: RowEditing }>): ReactElement {
  return (
    <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
      {editing.draft === undefined ? null : (
        <>
          <Button
            type="button"
            size="xs"
            disabled={!editing.dirty || editing.saving || editing.conflict}
            onClick={editing.save}
          >
            {editing.saving ? "Saving row..." : "Save row"}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={editing.saving}
            onClick={editing.cancel}
          >
            Cancel row
          </Button>
        </>
      )}
      {editing.conflict ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={editing.saving}
          onClick={editing.reload}
        >
          Reload row
        </Button>
      ) : null}
      <span
        role={
          editing.message === undefined || editing.message === "Row saved." ? "status" : "alert"
        }
        className="text-sm"
      >
        {editing.message}
      </span>
    </div>
  );
}

/** The same draft and controls open inside the phone card, including its heading field. */
function CardEditor({ context, row }: GridFeatureCommandProps): ReactElement | null {
  const editing = useContext(RowEditingContext);
  const id = useId();
  if (editing?.draft?.recordId !== row.recordId || context.presentation !== "cards") return null;
  return (
    <section
      aria-label="Edit row"
      className="space-y-3"
      onClick={(event) => event.stopPropagation()}
    >
      {editing.draft.fields.map((field) => (
        <div key={field.field} className="space-y-1">
          <Label htmlFor={`${id}-${field.field}`}>{field.label}</Label>
          <FieldControl
            id={`${id}-${field.field}`}
            field={field}
            editing={editing}
            events={context.events}
            current={linkedRecordTitle(row, field.field)}
          />
        </div>
      ))}
      <SaveControls editing={editing} />
    </section>
  );
}

export const gridFeature: GridFeatureModule = {
  Scope: RowEditScope,
  CellEditor: RowCell,
  RowCommands,
  RowEditor: CardEditor,
};
