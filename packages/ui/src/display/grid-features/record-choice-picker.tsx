"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
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
import { parseRecordChoicePage, type RecordChoiceOption } from "../../controls/projected-data";
import type { DisplayEventHandlers } from "../projected-data";
import type { LinkDraft } from "./edit-values";

/** A search reads once typing pauses this long, so a typed word is one read, not one per key. */
const SEARCH_DELAY_MS = 300;

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
}>): ReactElement {
  const [open, setOpen] = useState(autoOpen === true);
  const [search, setSearch] = useState("");
  const [choices, setChoices] = useState<readonly RecordChoiceOption[]>([]);
  const [next, setNext] = useState<string | undefined>(undefined);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const generation = useRef(0);
  const latestEvents = useRef(events);
  latestEvents.current = events;

  const read = (
    request: number,
    text: string,
    continuationToken: string | undefined,
    append: boolean,
  ): void => {
    const handler = latestEvents.current?.table_records_requested;
    if (handler === undefined) return;
    setState("loading");
    const bounded = text.trim().slice(0, 100);
    void Promise.resolve(
      handler({
        event: "table_records_requested",
        field: fieldId,
        purpose,
        ...(bounded === "" ? {} : { search: bounded }),
        ...(continuationToken === undefined ? {} : { continuationToken }),
      }),
    )
      .then((answer) => {
        if (generation.current !== request) return;
        const page = parseRecordChoicePage(answer);
        setChoices((held) => (append ? [...held, ...page.choices] : page.choices));
        setNext(page.nextContinuationToken);
        setState("idle");
      })
      .catch((cause: unknown) => {
        if (generation.current !== request) return;
        console.error("[record-choice-picker] records unavailable", cause);
        setState("failed");
      });
  };

  useEffect(() => {
    if (!open) {
      generation.current += 1;
      return;
    }
    const request = ++generation.current;
    const timeout = setTimeout(
      () => read(request, search, undefined, false),
      search.trim() === "" ? 0 : SEARCH_DELAY_MS,
    );
    return () => {
      clearTimeout(timeout);
      generation.current += 1;
    };
  }, [open, search, fieldId, purpose]);

  return (
    <Combobox
      items={choices}
      value={null}
      open={open}
      inputValue={search}
      onOpenChange={(nextOpen: boolean) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setSearch("");
          setChoices([]);
          setNext(undefined);
          setState("idle");
        }
        onOpenChange?.(nextOpen);
      }}
      onInputValueChange={(text: string) => setSearch(text)}
      onValueChange={(item: RecordChoiceOption | null) => {
        if (item !== null) onPick(item);
      }}
      itemToStringLabel={(item: RecordChoiceOption) => item.title}
      itemToStringValue={(item: RecordChoiceOption) => item.recordId}
      // The server already searched; every record it returned is offered.
      filter={() => true}
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
      <ComboboxContent>
        <ComboboxList>
          {(item: RecordChoiceOption) => (
            <ComboboxItem key={item.recordId} value={item}>
              <span className="truncate">{item.title}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty role="status">
          {state === "loading"
            ? "Searching…"
            : state === "failed"
              ? "Records could not be loaded. Try again."
              : "No matching records"}
        </ComboboxEmpty>
        {next === undefined ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full"
            disabled={state === "loading"}
            onClick={() => read(++generation.current, search, next, true)}
          >
            Load more
          </Button>
        )}
      </ComboboxContent>
    </Combobox>
  );
}

/**
 * A cell's or row's link control: the record now chosen (its title as the picker showed it, else
 * the cell's own displayed value), the shared picker to choose another, and a clear control for an
 * optional link. It only drafts; the editor around it commits through the one inline-edit path.
 */
export function LinkDraftPicker({
  fieldId,
  label,
  events,
  draft,
  current,
  required,
  disabled,
  autoOpen,
  inputRef,
  onKeyDown,
  onChange,
  onOpenChange,
  invalid,
  describedBy,
}: Readonly<{
  fieldId: string;
  label: string;
  events: DisplayEventHandlers | undefined;
  draft: LinkDraft;
  /** What the cell displays for the stored record, shown until another record is chosen. */
  current?: ReactNode;
  required: boolean;
  disabled?: boolean;
  autoOpen?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  onChange: (draft: LinkDraft) => void;
  onOpenChange?: (open: boolean) => void;
  invalid?: boolean;
  describedBy?: string;
}>): ReactElement {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-sm">
          {draft === null ? "None" : (draft.title ?? current ?? "Chosen record")}
        </span>
        {draft === null || required ? null : (
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
        )}
      </span>
      <RecordChoicePicker
        fieldId={fieldId}
        purpose="edit"
        label={label}
        events={events}
        placeholder={`Find ${label}`}
        {...(disabled === undefined ? {} : { disabled })}
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
    </span>
  );
}
