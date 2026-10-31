"use client";

import { useRef, useState, type KeyboardEvent, type ReactElement, type Ref } from "react";
import { Button } from "../../components/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "../../components/combobox";
import { Icon } from "../../icons/icon";
import { readRecordChoicePage, type RecordChoiceOption } from "../../controls/projected-data";
import {
  useRecordChoicePager,
  type RecordChoicePagerPage,
} from "../../controls/use-record-choice-pager";
import type { DisplayEventHandlers, DisplayRow } from "../projected-data";
import type { LinkDraft } from "./edit-values";
import { waitingForParent } from "../../controls/dependent-field";

/**
 * The one picker of a Records table's link field, for a column filter and for a cell editor. It
 * reads one bounded page of the field's target records under the viewer's access when it opens,
 * when the search pauses and when "Load more" continues the page; nothing is preloaded, and a read
 * that finishes after the picker closed or the search moved on is dropped. The host decides, per
 * request, whether the viewer may be offered the field's records for this purpose.
 */
export function RecordChoicePicker({
  fieldId,
  purpose,
  label,
  events,
  placeholder,
  disabled,
  autoOpen,
  inputRef,
  onKeyDown,
  onBlur,
  onPick,
  onOpenChange,
  invalid,
  describedBy,
  maxed,
  parentRecordId,
}: Readonly<{
  fieldId: string;
  purpose: "filter" | "edit";
  label: string;
  events: DisplayEventHandlers | undefined;
  placeholder: string;
  disabled?: boolean;
  /** Open on mount, for an editor that opens the picker as soon as the person starts editing. */
  autoOpen?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  onBlur?: () => void;
  onPick: (item: RecordChoiceOption) => void;
  onOpenChange?: (open: boolean) => void;
  invalid?: boolean;
  describedBy?: string;
  /** No further record may be chosen; the input is disabled. */
  maxed?: boolean;
  /** For a dependent link field: the record chosen in the field it depends on, in the draft. */
  parentRecordId?: string;
}>): ReactElement {
  const [open, setOpen] = useState(autoOpen === true);
  const [search, setSearch] = useState("");
  const latestEvents = useRef(events);
  latestEvents.current = events;

  const read = async (
    bounded: string,
    continuationToken?: string,
  ): Promise<RecordChoicePagerPage<RecordChoiceOption> | undefined> => {
    const handler = latestEvents.current?.table_records_requested;
    if (handler === undefined) return { items: [] };
    try {
      const answer = await Promise.resolve(
        handler({
          event: "table_records_requested",
          field: fieldId,
          purpose,
          ...(parentRecordId === undefined ? {} : { parentRecordId }),
          ...(bounded === "" ? {} : { search: bounded }),
          ...(continuationToken === undefined ? {} : { continuationToken }),
        }),
      );
      const page = readRecordChoicePage(answer);
      return {
        items: page.choices,
        ...(page.nextContinuationToken === undefined ? {} : { next: page.nextContinuationToken }),
      };
    } catch (cause) {
      console.error("[record-choice-picker] records unavailable", cause);
      return undefined;
    }
  };
  const pager = useRecordChoicePager<RecordChoiceOption>({
    open,
    search,
    read,
    disabled: disabled === true || maxed === true,
  });

  return (
    <Combobox
      items={pager.items}
      value={null}
      open={open}
      inputValue={search}
      onOpenChange={(nextOpen: boolean) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setSearch("");
          pager.reset();
        }
        onOpenChange?.(nextOpen);
      }}
      onInputValueChange={(text: string) => setSearch(text)}
      onValueChange={(item: RecordChoiceOption | null) => {
        if (item !== null) onPick(item);
      }}
      itemToStringLabel={(item: RecordChoiceOption) => item.title}
      itemToStringValue={(item: RecordChoiceOption) => item.recordId}
      // The server already searched: the list shows exactly the records it returned, as they
      // arrive, without filtering them again.
      filteredItems={pager.items}
      filter={null}
    >
      <ComboboxInput
        ref={inputRef}
        placeholder={placeholder}
        aria-label={`Find ${label} records`}
        aria-invalid={invalid === true ? true : undefined}
        aria-describedby={describedBy}
        disabled={disabled === true || maxed === true}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          event.stopPropagation();
          onKeyDown?.(event);
        }}
        {...(onBlur === undefined ? {} : { onBlur })}
      />
      <ComboboxContent className="min-w-64">
        <ComboboxList>
          {(item: RecordChoiceOption) => (
            <ComboboxItem key={item.recordId} value={item}>
              <span className="truncate">{item.title}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty role="status">
          {pager.loading
            ? "Searching…"
            : pager.failed
              ? "Records could not be loaded. Try again."
              : "No matching records"}
        </ComboboxEmpty>
        {pager.next === undefined ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full"
            disabled={pager.loading}
            onClick={() => pager.loadMore()}
          >
            Load more
          </Button>
        )}
      </ComboboxContent>
    </Combobox>
  );
}

/** The title a row shows for a field's linked record, so its link editor names the stored record. */
export const linkedRecordTitle = (row: DisplayRow, field: string): string | undefined => {
  const key = Object.keys(row.cells).find((cell) => cell.toLowerCase() === field.toLowerCase());
  const cell = key === undefined ? undefined : row.cells[key];
  return cell?.kind === "record_link" ? cell.label : undefined;
};

/**
 * A cell's or row's link control: the record now chosen (its title as the picker showed it, else
 * the row's own title for the stored record), the shared picker to choose another, and a clear
 * control for an optional link. In a grid cell (`inline`) the chosen record is the search box's
 * placeholder, so the control keeps the row's height; on a card it is a line above the search box.
 * It only drafts; the editor around it commits through the one inline-edit path.
 */
export function LinkDraftPicker({
  fieldId,
  label,
  events,
  draft,
  current,
  inline,
  required,
  disabled,
  autoOpen,
  inputRef,
  onKeyDown,
  onChange,
  onOpenChange,
  invalid,
  describedBy,
  dependency,
}: Readonly<{
  fieldId: string;
  label: string;
  events: DisplayEventHandlers | undefined;
  draft: LinkDraft;
  /** The title the row shows for the stored record, named until another record is chosen. */
  current?: string;
  /** Laid out on one line inside a grid cell. */
  inline?: boolean;
  required: boolean;
  disabled?: boolean;
  autoOpen?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  onChange: (draft: LinkDraft) => void;
  onOpenChange?: (open: boolean) => void;
  invalid?: boolean;
  describedBy?: string;
  /**
   * Set for a field that depends on another link field: the record chosen there (undefined while
   * none is, or while the viewer cannot read it), which the picker offers records for.
   */
  dependency?: Readonly<{ parentRecordId: string | undefined; parentLabel: string }>;
}>): ReactElement {
  const waiting = dependency !== undefined && dependency.parentRecordId === undefined;
  const chosen = draft === null ? "None" : (draft.title ?? current ?? "Chosen record");
  const clear =
    draft === null || required ? null : (
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Clear ${label}`}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          onChange(null);
        }}
      >
        <Icon name="close" aria-hidden="true" />
      </Button>
    );
  const picker = (
    <RecordChoicePicker
      fieldId={fieldId}
      purpose="edit"
      label={label}
      events={events}
      placeholder={
        waiting
          ? waitingForParent(dependency.parentLabel)
          : inline === true
            ? chosen
            : `Find ${label}`
      }
      {...(waiting || disabled === true ? { disabled: true } : {})}
      {...(dependency?.parentRecordId === undefined
        ? {}
        : { parentRecordId: dependency.parentRecordId })}
      {...(autoOpen === undefined ? {} : { autoOpen })}
      {...(inputRef === undefined ? {} : { inputRef })}
      {...(onKeyDown === undefined ? {} : { onKeyDown })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
      {...(invalid === undefined ? {} : { invalid })}
      {...(describedBy === undefined ? {} : { describedBy })}
      onPick={(item) =>
        onChange({ recordTypeId: item.recordTypeId, recordId: item.recordId, title: item.title })
      }
    />
  );
  return inline === true ? (
    <span className="flex min-w-0 items-center gap-1">
      <span className="min-w-0 flex-1">{picker}</span>
      {clear}
    </span>
  ) : (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-sm">{chosen}</span>
        {clear}
      </span>
      {picker}
    </span>
  );
}
