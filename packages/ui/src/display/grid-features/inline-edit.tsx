"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import type { JsonValue, RecordsTableInlineEditor } from "@vortex/platform/schema";
import { Button } from "../../components/button";
import { Checkbox } from "../../components/checkbox";
import { Input } from "../../components/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/popover";
import { NativeSelect, NativeSelectOption } from "../../components/native-select";
import { Spinner } from "../../components/spinner";
import { Textarea } from "../../components/textarea";
import { useUnsavedWorkRegistry } from "../../controls/unsaved-work";
import { useDateFormatOptions } from "../date-format-context";
import type {
  DisplayEventHandlers,
  DisplayInlineEditResult,
  DisplayRow,
  DisplaySemanticEvent,
} from "../projected-data";
import {
  readEditDraft,
  sameEditDraft,
  sameEditValue,
  startEditDraft,
  type EditDraft,
} from "./edit-values";
import { LinkDraftPicker, linkedRecordTitle } from "./record-choice-picker";
import { waitingForParent } from "../../controls/link-dependency-text";
import { dependentFieldsOf, parentFieldOf, storedRecordId } from "./link-dependency";
import type { GridFeatureCellProps, GridFeatureModule } from "./registry";

type Phase = "idle" | "editing" | "saving";

/** What the host answered; anything that is not a recognised result is shown as not saved. */
const asResult = (value: unknown): DisplayInlineEditResult => {
  if (typeof value === "object" && value !== null) {
    const result = value as Record<string, unknown>;
    if (result.kind === "saved") return { kind: "saved" };
    if (
      result.kind === "refused" &&
      typeof result.message === "string" &&
      typeof result.changed === "boolean"
    )
      return { kind: "refused", message: result.message, changed: result.changed };
  }
  return { kind: "refused", message: "That is not available right now.", changed: false };
};

/**
 * One editable cell. It shows the plain value until the person starts editing (Enter, F2 or a
 * click on the value), then holds a draft in the field's own control. Enter or leaving the control
 * commits it once; Escape cancels; Tab completes the edit and returns to grid navigation. The
 * commit is one `inline_edit` event carrying the record, the field, the revision the row was
 * displayed at, the new stored value and one command identity. Nothing is shown as saved until the
 * server confirmed it; a refusal stays on the cell with the draft, and a record that changed under
 * the person keeps the draft until they reload and retry against the refreshed revision.
 */
function EditableCell({
  eventId,
  row,
  field,
  label,
  editor,
  stored,
  handler,
  events,
  reload,
  dependency,
  dependents,
  children,
}: Readonly<{
  eventId: string;
  row: DisplayRow & Readonly<{ revision: number }>;
  field: string;
  label: string;
  editor: RecordsTableInlineEditor;
  stored: JsonValue | undefined;
  handler: (event: DisplaySemanticEvent) => unknown;
  /** The page's display callbacks, for a link editor's record picker. */
  events: DisplayEventHandlers | undefined;
  reload: (() => void) | undefined;
  /** For a link that depends on another: the record chosen there in this row, and its label. */
  dependency: Readonly<{ parentRecordId: string | undefined; parentLabel: string }> | undefined;
  /** The labels of the fields that depend on this one and hold a record in this row. */
  dependents: readonly string[];
  children: ReactNode;
}>): ReactElement {
  const { timeZone } = useDateFormatOptions();
  const zone = timeZone ?? "UTC";
  const ids = useId();
  const messageId = `${ids}-message`;
  const [phase, setPhaseState] = useState<Phase>("idle");
  // The phase the editor is in right now, readable by an event that fires before the next render
  // (a blur caused by Escape must not commit the draft Escape just cancelled).
  const phaseNow = useRef<Phase>("idle");
  const setPhase = (next: Phase): void => {
    phaseNow.current = next;
    setPhaseState(next);
  };
  const [draft, setDraft] = useState<EditDraft>(() => startEditDraft(editor, stored, zone));
  const [message, setMessage] = useState<string | undefined>(undefined);
  /** The revision a refused commit was made at; set only when the record changed under the person. */
  const [changedFrom, setChangedFrom] = useState<number | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const committing = useRef(false);
  const mounted = useRef(true);
  const trigger = useRef<HTMLButtonElement>(null);
  const editing = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(false);
  const linkEditor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The saved note is announced for a moment. Until the page read again after a saved commit shows
  // the new stored value, a switch keeps showing the confirmed draft: it is shown only while the
  // stored value is still the one the commit replaced.
  const storedNow = useRef(stored);
  storedNow.current = stored;
  const [replaced, setReplaced] = useState<Readonly<{ value: JsonValue | undefined }> | undefined>(
    undefined,
  );
  const awaitingRefresh = replaced !== undefined && replaced.value === stored;
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 4000);
    return () => clearTimeout(timer);
  }, [saved]);

  const unsaved = useUnsavedWorkRegistry();
  const cancel = (): void => {
    setPhase("idle");
    setMessage(undefined);
    setChangedFrom(undefined);
    setDraft(startEditDraft(editor, stored, zone));
  };
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  // An edit with a draft or a standing refusal is unsaved work for the page's leave prompt.
  const holdsWork =
    phase === "saving" ||
    (phase === "editing" &&
      (message !== undefined || !sameEditDraft(draft, startEditDraft(editor, stored, zone))));
  useEffect(() => {
    if (unsaved === undefined || !holdsWork) return;
    const formId = `inline-edit:${row.recordId}:${field}`;
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
  }, [unsaved, holdsWork, row.recordId, field]);

  // Focus follows the editor: into the control when editing starts, back to the value after.
  useEffect(() => {
    if (phase === "editing") editing.current?.focus();
    else if (phase === "idle" && restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
  }, [phase]);

  const start = (): void => {
    setDraft(startEditDraft(editor, stored, zone));
    setMessage(undefined);
    setChangedFrom(undefined);
    setSaved(false);
    setPhase("editing");
  };

  const commit = async (next: EditDraft = draft, afterCommit?: () => void): Promise<void> => {
    if (committing.current) return;
    const reading = readEditDraft(editor, next, label, zone);
    if (!reading.ok) {
      setMessage(reading.message);
      setPhase("editing");
      return;
    }
    if (sameEditValue(editor, stored, reading.value)) {
      restoreFocus.current = true;
      cancel();
      afterCommit?.();
      return;
    }
    if (dependents.length > 0) {
      // A changed parent would leave its dependents holding records the server refuses.
      setMessage(
        `${dependents.join(" and ")} depend${dependents.length === 1 ? "s" : ""} on ${label}. Clear ${dependents.length === 1 ? "it" : "them"} first, or change them together in one row edit.`,
      );
      setPhase("editing");
      return;
    }
    committing.current = true;
    setPhase("saving");
    setMessage(undefined);
    let result: DisplayInlineEditResult;
    try {
      result = asResult(
        await handler({
          event: "inline_edit",
          eventId,
          recordId: row.recordId,
          revision: row.revision,
          field,
          value: reading.value,
          commandId: crypto.randomUUID(),
        }),
      );
    } catch {
      result = { kind: "refused", message: "That is not available right now.", changed: false };
    } finally {
      committing.current = false;
    }
    if (!mounted.current) return;
    if (result.kind === "saved") {
      setSaved(true);
      setReplaced({ value: storedNow.current });
      setMessage(undefined);
      setChangedFrom(undefined);
      restoreFocus.current = true;
      setPhase("idle");
      afterCommit?.();
      return;
    }
    setMessage(result.message);
    setChangedFrom(result.changed ? row.revision : undefined);
    setPhase("editing");
  };

  const leave = (): void => {
    // Back to grid navigation: the grid's own cell takes focus, not the value inside it.
    restoreFocus.current = false;
    trigger.current?.closest<HTMLElement>("[data-grid-cell]")?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    // The editor owns its keys; only Escape from the idle value reaches the grid.
    event.stopPropagation();
    if (phase !== "editing") return;
    if (event.key === "Escape") {
      event.preventDefault();
      restoreFocus.current = true;
      cancel();
    } else if (
      event.key === "Enter" &&
      !(editor.kind === "text" && editor.input === "long_text" && event.shiftKey)
    ) {
      event.preventDefault();
      void commit();
    } else if (event.key === "Tab") {
      event.preventDefault();
      void commit(draft, leave);
    }
  };

  const describedBy = message === undefined ? undefined : messageId;
  const stale = changedFrom !== undefined && changedFrom !== row.revision;
  const notice =
    message === undefined ? null : (
      <span
        id={messageId}
        role="alert"
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs whitespace-normal text-destructive"
      >
        <span>{message}</span>
        {changedFrom === undefined ? null : (
          <>
            {reload === undefined || stale ? null : (
              <Button type="button" variant="outline" size="xs" onClick={reload}>
                Reload
              </Button>
            )}
            {stale ? (
              <>
                <span className="text-muted-foreground">Now:</span>
                {children}
                <Button type="button" variant="outline" size="xs" onClick={() => void commit()}>
                  Retry
                </Button>
              </>
            ) : null}
          </>
        )}
      </span>
    );
  // A refusal is told beside the control, in a popover anchored to it: the row keeps its height and
  // focus stays in the control. It is announced as an alert and goes with the edit, never the page.
  const withNotice = (control: ReactElement): ReactElement => (
    <Popover open={message !== undefined}>
      <PopoverTrigger
        nativeButton={false}
        render={<span className="flex min-w-0 items-center gap-2" />}
      >
        {control}
        {phase === "saving" ? <Spinner /> : null}
      </PopoverTrigger>
      <PopoverContent align="start" initialFocus={false} finalFocus={false} className="w-80">
        {notice}
      </PopoverContent>
    </Popover>
  );
  const status = (
    <span role="status" className="sr-only">
      {saved ? `${label} saved.` : phase === "saving" ? `Saving ${label}.` : ""}
    </span>
  );

  if (editor.kind === "yes_no") {
    const checked = phase === "saving" || awaitingRefresh ? draft === true : stored === true;
    return (
      <span
        className="flex flex-col"
        onKeyDown={(event) => {
          // Space toggles the switch itself; only Escape reaches the grid, which returns to the cell.
          if (event.key !== "Escape") event.stopPropagation();
        }}
      >
        {withNotice(
          <Checkbox
            aria-label={`Edit ${label}`}
            aria-invalid={message === undefined ? undefined : true}
            aria-describedby={describedBy}
            aria-busy={phase === "saving" ? true : undefined}
            checked={checked}
            disabled={phase === "saving"}
            onClick={(event) => event.stopPropagation()}
            onCheckedChange={(next) => {
              setSaved(false);
              setDraft(next);
              void commit(next);
            }}
          />,
        )}
        {status}
      </span>
    );
  }

  if (phase === "idle")
    return (
      <>
        <button
          ref={trigger}
          type="button"
          data-inline-edit={field}
          className="block w-full min-w-0 cursor-text truncate [text-align:inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={(event) => {
            event.stopPropagation();
            start();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") return;
            event.stopPropagation();
            if (event.key === "F2") {
              event.preventDefault();
              start();
            }
          }}
        >
          {children}
          <span className="sr-only">. Press Enter to edit {label}.</span>
        </button>
        {status}
      </>
    );

  const common = {
    "aria-label": `Edit ${label}`,
    "aria-invalid": message === undefined ? undefined : true,
    "aria-describedby": describedBy,
    "aria-busy": phase === "saving" ? true : undefined,
    disabled: phase === "saving",
    onKeyDown,
    onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
    onBlur: () => {
      if (phaseNow.current === "editing" && !committing.current) void commit();
    },
  } as const;

  if (editor.kind === "link") {
    const currentTitle = linkedRecordTitle(row, field);
    return (
      <span
        ref={linkEditor}
        className="flex min-w-0 flex-col"
        onKeyDown={(event) => {
          // The picker owns its keys while open; Escape leaves the edit.
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            restoreFocus.current = true;
            cancel();
          }
        }}
      >
        {withNotice(
          <LinkDraftPicker
            fieldId={field}
            label={label}
            events={events}
            draft={typeof draft === "object" ? draft : null}
            {...(currentTitle === undefined ? {} : { current: currentTitle })}
            {...(dependency === undefined ? {} : { dependency })}
            inline
            required={editor.required}
            disabled={phase === "saving"}
            autoOpen
            inputRef={(element) => {
              editing.current = element;
            }}
            invalid={message !== undefined}
            {...(describedBy === undefined ? {} : { describedBy })}
            onChange={(next) => {
              setDraft(next);
              void commit(next);
            }}
            onOpenChange={(open) => {
              if (open) return;
              // The picker closing without a choice ends the edit, unless focus moved to the
              // editor's own clear control or a commit is under way.
              setTimeout(() => {
                if (
                  phaseNow.current === "editing" &&
                  !committing.current &&
                  message === undefined &&
                  !linkEditor.current?.contains(document.activeElement)
                ) {
                  restoreFocus.current = false;
                  cancelRef.current();
                }
              }, 0);
            }}
          />,
        )}
        {status}
      </span>
    );
  }

  let control: ReactElement;
  switch (editor.kind) {
    case "choice":
      control = (
        <NativeSelect
          {...common}
          ref={(element: HTMLSelectElement | null) => {
            editing.current = element;
          }}
          size="sm"
          className="w-full"
          value={typeof draft === "string" ? draft : ""}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            void commit(event.currentTarget.value);
          }}
        >
          {editor.required ? null : <NativeSelectOption value="">None</NativeSelectOption>}
          {editor.options.map((option) => (
            <NativeSelectOption key={option.value} value={option.value}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      );
      break;
    case "text":
      control =
        editor.input === "long_text" ? (
          <Textarea
            {...common}
            ref={(element) => {
              editing.current = element;
            }}
            rows={2}
            value={typeof draft === "string" ? draft : ""}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
        ) : (
          <Input
            {...common}
            ref={(element) => {
              editing.current = element;
            }}
            type={editor.input === "email" ? "email" : editor.input === "phone" ? "tel" : "text"}
            value={typeof draft === "string" ? draft : ""}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
        );
      break;
    default:
      control = (
        <Input
          {...common}
          ref={(element) => {
            editing.current = element;
          }}
          type={
            editor.kind === "date"
              ? "date"
              : editor.kind === "date_time"
                ? "datetime-local"
                : "text"
          }
          {...(editor.kind === "date_time" ? { step: 1 } : {})}
          {...(editor.kind === "whole_number" ? { inputMode: "numeric" as const } : {})}
          {...(editor.kind === "decimal" ? { inputMode: "decimal" as const } : {})}
          value={typeof draft === "string" ? draft : ""}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
      );
  }
  return (
    <span className="flex min-w-0 flex-col">
      {withNotice(control)}
      {status}
    </span>
  );
}

/**
 * Inline editing: a cell becomes its editor only for a field the projection lets this viewer edit,
 * on a row whose own capabilities allow updating that field, and only with the stored value the
 * server sent for that row. Every other cell keeps its plain value, so calculated, system, withheld
 * and unsupported fields stay read-only. The row revision travels with the commit so the server
 * refuses a stale change.
 */
function InlineEditor({ context, row, column, children }: GridFeatureCellProps): ReactElement {
  const inlineEdit = context.features.inlineEdit;
  const onInlineEdit = context.events?.inline_edit;
  const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
  const field = inlineEdit?.fields.find((candidate) => same(candidate.field, column.key));
  const storedKey =
    row.edit === undefined ? undefined : Object.keys(row.edit).find((key) => same(key, column.key));
  const editable =
    inlineEdit !== undefined &&
    field !== undefined &&
    onInlineEdit !== undefined &&
    row.revision !== undefined &&
    storedKey !== undefined &&
    row.capabilities !== undefined &&
    row.capabilities.actions.includes("update") &&
    row.capabilities.changeableFieldIds.some((fieldId) => same(fieldId, column.key));
  const onRefresh = context.events?.refresh;
  const reload = useCallback((): void => {
    onRefresh?.({ event: "refresh" });
  }, [onRefresh]);
  if (!editable || row.edit === undefined || storedKey === undefined) return <>{children}</>;
  const labelOf = (key: string): string =>
    context.columns.find((candidate) => same(candidate.key, key))?.label ?? key;
  const storedOf = (key: string): unknown =>
    row.edit![Object.keys(row.edit!).find((candidate) => same(candidate, key)) ?? ""];
  const parentField = parentFieldOf(field.editor);
  const dependency =
    parentField === undefined
      ? undefined
      : {
          parentRecordId: storedRecordId(storedOf(parentField)),
          parentLabel: labelOf(parentField),
        };
  if (dependency !== undefined && dependency.parentRecordId === undefined)
    // The parent is empty or not readable: the dependent link stays as it is, with a neutral reason.
    return (
      <span
        title={waitingForParent(dependency.parentLabel)}
        aria-description={waitingForParent(dependency.parentLabel)}
      >
        {children}
      </span>
    );
  const dependents = dependentFieldsOf(inlineEdit.fields, column.key)
    .filter((child) => storedRecordId(storedOf(child.field)) !== undefined)
    .map((child) => labelOf(child.field));
  return (
    // Keyed by record and field, never by value: a refresh keeps the draft and its refusal.
    <EditableCell
      key={`${row.recordId}\u0000${column.key}`}
      eventId={inlineEdit.eventId}
      row={row as DisplayRow & Readonly<{ revision: number }>}
      field={column.key}
      label={column.label}
      editor={field.editor}
      stored={row.edit[storedKey]}
      handler={onInlineEdit}
      events={context.events}
      reload={onRefresh === undefined ? undefined : reload}
      dependency={dependency}
      dependents={dependents}
    >
      {children}
    </EditableCell>
  );
}

export const gridFeature: GridFeatureModule = { CellEditor: InlineEditor };
