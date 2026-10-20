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
  type JsonValue,
  type RecordsTableInlineEditor,
} from "@vortex/platform/schema";
import { Button } from "../../components/button";
import { Checkbox } from "../../components/checkbox";
import { Input } from "../../components/input";
import { Label } from "../../components/label";
import { NativeSelect, NativeSelectOption } from "../../components/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/popover";
import { Textarea } from "../../components/textarea";
import { useUnsavedWorkRegistry } from "../../controls/unsaved-work";
import { Pencil } from "lucide-react";
import { useDateFormatOptions } from "../date-format-context";
import { fail, requireRecord, type DisplayRow } from "../projected-data";
import { readEditDraft, sameEditValue, startEditDraft, type EditDraft } from "./edit-values";
import type {
  GridFeatureCellProps,
  GridFeatureCommandProps,
  GridFeatureModule,
  GridFeaturePointProps,
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
      (field) => field.draft !== startEditDraft(field.editor, field.stored, draft.timeZone),
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

  // A new projection may remove access. Forget the entire draft rather than retaining a withheld
  // value in an editor. A conflict with unchanged access keeps the original draft and revision.
  useEffect(() => {
    if (draft === undefined || saving) return;
    const current = context.rows.find((row) => same(row.recordId, draft.recordId));
    if (current === undefined) return;
    const allowed = context.features.rowEdit;
    if (
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
  }, [context.features.rowEdit, context.rows, draft, saving]);

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
    const handler = context.events?.row_edit;
    if (draft === undefined || handler === undefined || submitting.current || conflict) return;
    const values: Record<string, JsonValue> = {};
    const invalid: Record<string, string> = {};
    for (const field of draft.fields) {
      if (field.draft === startEditDraft(field.editor, field.stored, draft.timeZone)) continue;
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
          event: "row_edit",
          eventId: draft.eventId,
          recordId: draft.recordId,
          revision: draft.revision,
          values,
          commandId: crypto.randomUUID(),
        }),
        "A row save must return its outcome",
        { propertyPath: ["row_edit"] },
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
        setMessage(answer.message);
        setConflict(answer.changed);
        // Rules without a field location apply to the row as a whole. Attach their safe message
        // to every submitted cell as well as announcing it at the row's Save control.
        const corrections =
          answer.corrections === undefined
            ? []
            : flowFieldCorrectionSchema.array().parse(answer.corrections);
        const located = corrections.filter((correction) =>
          Object.keys(values).some((field) => same(field, correction.field)),
        );
        setErrors(
          Object.fromEntries(
            located.length === 0
              ? Object.keys(values).map((field) => [field, answer.message as string])
              : located.map((correction) => [
                  Object.keys(values).find((field) => same(field, correction.field))!,
                  correction.message ??
                    (correction.code === "required_value"
                      ? "This field is required."
                      : "Check this value."),
                ]),
          ),
        );
      } else fail("A row save returned an invalid outcome", { propertyPath: ["row_edit"] });
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
      if (!submitting.current)
        setDraft((current) =>
          current === undefined
            ? current
            : {
                ...current,
                fields: current.fields.map((entry) =>
                  same(entry.field, field) ? { ...entry, draft: value } : entry,
                ),
              },
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
  return <RowEditingContext.Provider value={editing}>{children}</RowEditingContext.Provider>;
}

/** Controls are shadcn primitives; the shared edit-values module owns every type conversion. */
function FieldControl({
  field,
  editing,
}: Readonly<{ field: FieldDraft; editing: RowEditing }>): ReactElement {
  const id = useId();
  const message = editing.errors[field.field];
  const props = {
    id,
    "aria-label": `Edit ${field.label}`,
    "aria-invalid": message !== undefined,
    "aria-describedby": message === undefined ? undefined : `${id}-error`,
    disabled: editing.saving,
  };
  const editor = field.editor;
  const text = typeof field.draft === "string" ? field.draft : "";
  let control: ReactElement;
  if (editor.kind === "yes_no")
    control = (
      <Checkbox
        {...props}
        checked={field.draft === true}
        onCheckedChange={(value) => editing.change(field.field, value)}
      />
    );
  else if (editor.kind === "choice")
    control = (
      <NativeSelect
        {...props}
        className="w-full"
        size="sm"
        value={text}
        onChange={(event) => editing.change(field.field, event.currentTarget.value)}
      >
        {!editor.required ? <NativeSelectOption value="">None</NativeSelectOption> : null}
        {editor.options.map((option) => (
          <NativeSelectOption key={option.value} value={option.value}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    );
  else if (editor.kind === "text" && editor.input === "long_text")
    control = (
      <Textarea
        {...props}
        rows={2}
        value={text}
        onChange={(event) => editing.change(field.field, event.currentTarget.value)}
      />
    );
  else
    control = (
      <Input
        {...props}
        value={text}
        type={
          editor.kind === "date"
            ? "date"
            : editor.kind === "date_time"
              ? "datetime-local"
              : editor.kind === "text" && editor.input === "email"
                ? "email"
                : editor.kind === "text" && editor.input === "phone"
                  ? "tel"
                  : "text"
        }
        {...(editor.kind === "whole_number"
          ? { inputMode: "numeric" as const }
          : editor.kind === "decimal"
            ? { inputMode: "decimal" as const }
            : {})}
        {...(editor.kind === "date_time" ? { step: 1 } : {})}
        onChange={(event) => editing.change(field.field, event.currentTarget.value)}
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
    <FieldControl field={field} editing={editing} />
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
    context.events?.row_edit === undefined
  )
    return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Edit row"
      disabled={editing.draft !== undefined || editing.saving}
      onClick={(event) => {
        event.stopPropagation();
        editing.start(row);
      }}
    >
      <Pencil aria-hidden="true" />
    </Button>
  );
}

function SaveControls({ editing }: Readonly<{ editing: RowEditing }>): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-2" onClick={(event) => event.stopPropagation()}>
      {editing.draft === undefined ? null : (
        <>
          <Button
            type="button"
            size="sm"
            disabled={!editing.dirty || editing.saving || editing.conflict}
            onClick={editing.save}
          >
            {editing.saving ? "Saving row..." : "Save row"}
          </Button>
          <Button
            type="button"
            size="sm"
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

function Toolbar({ context }: GridFeaturePointProps): ReactElement | null {
  const editing = useContext(RowEditingContext);
  return editing === undefined || context.presentation === "cards" ? null : (
    <SaveControls editing={editing} />
  );
}

/** The same draft and controls open inside the phone card, including its heading field. */
function CardEditor({ context, row }: GridFeatureCommandProps): ReactElement | null {
  const editing = useContext(RowEditingContext);
  if (editing?.draft?.recordId !== row.recordId || context.presentation !== "cards") return null;
  return (
    <section
      aria-label="Edit row"
      className="space-y-3"
      onClick={(event) => event.stopPropagation()}
    >
      {editing.draft.fields.map((field) => (
        <div key={field.field} className="space-y-1">
          <Label>{field.label}</Label>
          <FieldControl field={field} editing={editing} />
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
  ToolbarItems: Toolbar,
  RowEditor: CardEditor,
};
