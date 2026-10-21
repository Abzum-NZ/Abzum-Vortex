"use client";

import type { KeyboardEvent, ReactElement } from "react";
import type { RecordsTableInlineEditor } from "@vortex/platform/schema";
import { Checkbox } from "../../components/checkbox";
import { Input } from "../../components/input";
import { NativeSelect, NativeSelectOption } from "../../components/native-select";
import { Textarea } from "../../components/textarea";
import { waitingForParent } from "../../controls/dependent-field";
import type { DisplayEventHandlers } from "../projected-data";
import type { EditDraft } from "./edit-values";
import { optionsForParent } from "./link-dependency";
import { LinkDraftPicker } from "./record-choice-picker";

/** The field a dependent choice or link waits for, and what is chosen there now. */
export type EditFieldParent = Readonly<{
  /** The parent's chosen option or record, undefined while it is empty or not readable. */
  choiceKey: string | undefined;
  label: string;
}>;

/**
 * The one control of a grid field being edited, whichever surface edits it (an inline cell, a row
 * editor in a grid cell, a card). It draws the field's own control by kind and reports every new
 * draft through `onChange`; reading the draft into a stored value stays with `edit-values`, and
 * saving stays with the surface. A choice or link that depends on another field offers only what
 * the parent's chosen value allows and waits while the parent is empty.
 */
export function EditFieldControl({
  editor,
  fieldId,
  label,
  draft,
  onChange,
  disabled = false,
  invalid = false,
  describedBy,
  id,
  events,
  current,
  parent,
  inline,
  busy,
  autoOpenPicker,
  controlRef,
  onControlKeyDown,
  onControlBlur,
  onPickerOpenChange,
}: Readonly<{
  editor: RecordsTableInlineEditor;
  fieldId: string;
  label: string;
  draft: EditDraft;
  /** Receives each new draft; `final` is true when a choice or a linked record was picked. */
  onChange: (next: EditDraft, final: boolean) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string | undefined;
  id?: string | undefined;
  /** The page's display callbacks, for a link's record picker. */
  events: DisplayEventHandlers | undefined;
  /** The row's title for a stored link, named until another record is chosen. */
  current?: string | undefined;
  parent?: EditFieldParent | undefined;
  /** Laid out on one line inside a grid cell. */
  inline?: boolean | undefined;
  busy?: boolean | undefined;
  autoOpenPicker?: boolean | undefined;
  controlRef?:
    | ((element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null) => void)
    | undefined;
  onControlKeyDown?: ((event: KeyboardEvent<HTMLElement>) => void) | undefined;
  onControlBlur?: (() => void) | undefined;
  onPickerOpenChange?: ((open: boolean) => void) | undefined;
}>): ReactElement {
  const text = typeof draft === "string" ? draft : "";
  const common = {
    ...(id === undefined ? {} : { id }),
    "aria-label": `Edit ${label}`,
    "aria-invalid": invalid,
    "aria-describedby": describedBy,
    "aria-busy": busy === true ? true : undefined,
    disabled,
    ...(onControlKeyDown === undefined ? {} : { onKeyDown: onControlKeyDown }),
    ...(onControlBlur === undefined ? {} : { onBlur: onControlBlur }),
  };
  if (editor.kind === "link")
    return (
      <LinkDraftPicker
        fieldId={fieldId}
        label={label}
        events={events}
        draft={typeof draft === "object" ? draft : null}
        {...(current === undefined ? {} : { current })}
        {...(inline === undefined ? {} : { inline })}
        {...(parent === undefined
          ? {}
          : { dependency: { parentRecordId: parent.choiceKey, parentLabel: parent.label } })}
        required={editor.required}
        disabled={disabled}
        {...(autoOpenPicker === true ? { autoOpen: true } : {})}
        {...(controlRef === undefined ? {} : { inputRef: controlRef })}
        invalid={invalid}
        {...(describedBy === undefined ? {} : { describedBy })}
        onChange={(next) => onChange(next, true)}
        {...(onPickerOpenChange === undefined ? {} : { onOpenChange: onPickerOpenChange })}
      />
    );
  if (editor.kind === "yes_no")
    return (
      <Checkbox
        {...common}
        checked={draft === true}
        onCheckedChange={(value) => onChange(value, true)}
      />
    );
  if (editor.kind === "choice") {
    // A dependent choice offers only the options of the parent's chosen option, and waits for it.
    const waiting = parent !== undefined && parent.choiceKey === undefined;
    const waitingText = waiting && parent !== undefined ? waitingForParent(parent.label) : "";
    return (
      <NativeSelect
        {...common}
        disabled={disabled || waiting}
        {...(waiting ? { title: waitingText, "aria-description": waitingText } : {})}
        {...(controlRef === undefined ? {} : { ref: controlRef })}
        className="w-full"
        size="sm"
        value={text}
        onChange={(event) => onChange(event.currentTarget.value, true)}
      >
        {editor.required ? null : <NativeSelectOption value="">None</NativeSelectOption>}
        {optionsForParent(editor, parent?.choiceKey).map((option) => (
          <NativeSelectOption key={option.value} value={option.value}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    );
  }
  if (editor.kind === "text" && editor.input === "long_text")
    return (
      <Textarea
        {...common}
        {...(controlRef === undefined ? {} : { ref: controlRef })}
        rows={2}
        value={text}
        onChange={(event) => onChange(event.currentTarget.value, false)}
      />
    );
  return (
    <Input
      {...common}
      {...(controlRef === undefined ? {} : { ref: controlRef })}
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
      onChange={(event) => onChange(event.currentTarget.value, false)}
    />
  );
}
