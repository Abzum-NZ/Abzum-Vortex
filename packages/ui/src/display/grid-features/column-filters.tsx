"use client";

import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import {
  canonicalRecordsTableDecimal,
  compareRecordsTableDecimals,
  encodeRecordsTableFieldFilter,
  isRecordsTableCalendarDay,
  RECORDS_TABLE_MAXIMUM_FILTER_CHOICES,
  RECORDS_TABLE_MAXIMUM_FILTER_RECORDS,
  type RecordsTableFieldFilter,
  type RecordsTableFilterField,
} from "@vortex/platform/schema";
import { Badge } from "../../components/badge";
import { Button } from "../../components/button";
import { Calendar, calendarDay } from "../../components/calendar";
import { Checkbox } from "../../components/checkbox";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "../../components/combobox";
import { Input } from "../../components/input";
import { InputGroup, InputGroupAddon, InputGroupText } from "../../components/input-group";
import { Label } from "../../components/label";
import { NativeSelect, NativeSelectOption } from "../../components/native-select";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../../components/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/tooltip";
import { Icon } from "../../icons/icon";
import { FormattedDate } from "../date-format-context";
import { parseRecordChoicePage, type RecordChoiceOption } from "../../controls/projected-data";
import type { DisplayEventHandlers, TableNarrowing } from "../projected-data";
import type { GridFeatureColumnProps, GridFeatureModule, GridFeaturePointProps } from "./registry";

/** A text filter commits once typing pauses this long, so a typed word is one read, not one per key. */
const TEXT_COMMIT_DELAY_MS = 300;

const sameKey = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const appliedFilter = (
  narrowing: TableNarrowing | undefined,
  fieldId: string,
): RecordsTableFieldFilter | undefined =>
  narrowing?.filters.find((filter) => sameKey(filter.fieldId, fieldId))?.filter;

/**
 * Reports one field's committed filter in its address spelling; undefined clears it. The host
 * writes it into the page address and reads the table again on the server: the grid never filters
 * the rows it shows.
 */
const commitFilter = (
  events: DisplayEventHandlers | undefined,
  fieldId: string,
  filter: RecordsTableFieldFilter | undefined,
): void => {
  void events?.filter_changed?.({
    event: "filter_changed",
    field: fieldId,
    value: filter === undefined ? "" : encodeRecordsTableFieldFilter(filter),
  });
};

/** How a range reads in a chip: both ends, or one open end. */
const rangeText = (from: string | undefined, to: string | undefined, unit = ""): string =>
  from !== undefined && to !== undefined
    ? `${unit}${from} – ${unit}${to}`
    : from !== undefined
      ? `≥ ${unit}${from}`
      : `≤ ${unit}${to ?? ""}`;

/** What a committed filter shows in its chip. */
function FilterSummary({
  field,
  filter,
  narrowing,
}: Readonly<{
  field: RecordsTableFilterField;
  filter: RecordsTableFieldFilter;
  narrowing: TableNarrowing | undefined;
}>): ReactElement {
  switch (filter.kind) {
    case "empty":
      return <>is empty</>;
    case "text":
      return <>contains “{filter.text}”</>;
    case "choice":
      return (
        <>
          {filter.values
            .map((value) => field.options?.find((option) => option.value === value)?.label ?? value)
            .join(", ")}
        </>
      );
    case "number":
      return <>{rangeText(filter.from, filter.to)}</>;
    case "money":
      return <>{rangeText(filter.from, filter.to, `${filter.currency} `)}</>;
    case "date":
      return filter.from !== undefined && filter.to !== undefined ? (
        <>
          <FormattedDate iso={filter.from} /> – <FormattedDate iso={filter.to} />
        </>
      ) : filter.from !== undefined ? (
        <>
          from <FormattedDate iso={filter.from} />
        </>
      ) : (
        <>
          until <FormattedDate iso={filter.to ?? ""} />
        </>
      );
    case "link":
      return (
        <>
          {filter.recordIds
            .map((recordId) => narrowing?.recordTitles?.[recordId] ?? "Restricted record")
            .join(", ")}
        </>
      );
    case "yes_no":
      return <>{filter.value ? "Yes" : "No"}</>;
  }
}

/** A text filter: commits after a short pause or on Enter, and clears when emptied. */
function TextEditor({
  field,
  applied,
  onCommit,
}: Readonly<{
  field: RecordsTableFilterField;
  applied: Extract<RecordsTableFieldFilter, { kind: "text" }> | undefined;
  onCommit: (filter: RecordsTableFieldFilter | undefined) => void;
}>): ReactElement {
  const id = useId();
  const [text, setText] = useState(applied?.text ?? "");
  const committed = useRef(applied?.text ?? "");
  const [shown, setShown] = useState(applied?.text ?? "");
  const incoming = applied?.text ?? "";
  if (shown !== incoming) {
    setShown(incoming);
    // Acknowledging our own commit must not erase text typed while its read was pending.
    if (incoming !== committed.current) {
      setText(incoming);
      committed.current = incoming;
    }
  }
  const commit = (next: string): void => {
    const trimmed = next.trim();
    if (trimmed === committed.current) return;
    committed.current = trimmed;
    onCommit(trimmed === "" ? undefined : { kind: "text", text: trimmed });
  };
  const latest = useRef(commit);
  latest.current = commit;
  useEffect(() => {
    const timeout = setTimeout(() => latest.current(text), TEXT_COMMIT_DELAY_MS);
    return () => clearTimeout(timeout);
  }, [text]);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Contains</Label>
      <Input
        id={id}
        type="search"
        value={text}
        maxLength={200}
        autoFocus
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            commit(text);
          }
        }}
        aria-label={`${field.label} contains`}
      />
    </div>
  );
}

/** A choice filter: any of the checked options; each change commits, and none checked clears. */
function ChoiceEditor({
  field,
  applied,
  onCommit,
}: Readonly<{
  field: RecordsTableFilterField;
  applied: Extract<RecordsTableFieldFilter, { kind: "choice" }> | undefined;
  onCommit: (filter: RecordsTableFieldFilter | undefined) => void;
}>): ReactElement {
  const baseId = useId();
  const incoming = JSON.stringify(applied?.values ?? []);
  const [shown, setShown] = useState(incoming);
  const [chosen, setChosen] = useState<readonly string[]>(applied?.values ?? []);
  if (shown !== incoming) {
    setShown(incoming);
    setChosen(applied?.values ?? []);
  }
  const toggle = (value: string, on: boolean): void => {
    const next = on ? [...chosen, value] : chosen.filter((held) => held !== value);
    setChosen(next);
    onCommit(next.length === 0 ? undefined : { kind: "choice", values: next });
  };
  return (
    <fieldset className="flex max-h-64 flex-col gap-2 overflow-y-auto">
      <legend className="sr-only">{field.label} is any of</legend>
      {(field.options ?? []).map((option, index) => (
        <div key={option.value} className="flex items-center gap-2">
          <Checkbox
            id={`${baseId}-${index}`}
            checked={chosen.includes(option.value)}
            disabled={
              !chosen.includes(option.value) &&
              chosen.length >= RECORDS_TABLE_MAXIMUM_FILTER_CHOICES
            }
            onCheckedChange={(on: boolean) => toggle(option.value, on)}
          />
          <Label htmlFor={`${baseId}-${index}`} className="font-normal">
            {option.label}
          </Label>
        </div>
      ))}
    </fieldset>
  );
}

/** A number or money range: either end may stay open; Apply commits, and a bad range says why. */
function RangeEditor({
  field,
  applied,
  onCommit,
}: Readonly<{
  field: RecordsTableFilterField;
  applied: Extract<RecordsTableFieldFilter, { kind: "number" | "money" }> | undefined;
  onCommit: (filter: RecordsTableFieldFilter | undefined) => void;
}>): ReactElement {
  const id = useId();
  const [from, setFrom] = useState(applied?.from ?? "");
  const [to, setTo] = useState(applied?.to ?? "");
  const currency = applied?.kind === "money" ? applied.currency : (field.currency ?? "");
  const [currencyText, setCurrencyText] = useState(currency);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const apply = (): void => {
    const fromText = from.trim();
    const toText = to.trim();
    if (fromText === "" && toText === "") {
      setProblem(undefined);
      onCommit(undefined);
      return;
    }
    const low = fromText === "" ? undefined : canonicalRecordsTableDecimal(fromText);
    const high = toText === "" ? undefined : canonicalRecordsTableDecimal(toText);
    if ((fromText !== "" && low === undefined) || (toText !== "" && high === undefined)) {
      setProblem("Enter plain numbers, such as 1250 or 99.95.");
      return;
    }
    if (low !== undefined && high !== undefined && compareRecordsTableDecimals(low, high) > 0) {
      setProblem("The lower end must not be above the upper end.");
      return;
    }
    const range = {
      ...(low === undefined ? {} : { from: low }),
      ...(high === undefined ? {} : { to: high }),
    };
    if (field.kind === "money") {
      const code = currencyText.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(code)) {
        setProblem("Enter a three-letter currency code, such as NZD.");
        return;
      }
      setProblem(undefined);
      onCommit({ kind: "money", currency: code, ...range });
      return;
    }
    setProblem(undefined);
    onCommit({ kind: "number", ...range });
  };
  const bound = (label: string, value: string, set: (next: string) => void, suffix: string) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${id}-${suffix}`}>{label}</Label>
      <InputGroup>
        {field.kind === "money" && currencyText !== "" ? (
          <InputGroupAddon>
            <InputGroupText>{currencyText.toUpperCase()}</InputGroupText>
          </InputGroupAddon>
        ) : null}
        <Input
          id={`${id}-${suffix}`}
          inputMode="decimal"
          value={value}
          className="border-0 shadow-none focus-visible:ring-0"
          onChange={(event) => set(event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              apply();
            }
          }}
          aria-invalid={problem !== undefined}
        />
      </InputGroup>
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      {field.kind === "money" && field.currency === undefined ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-currency`}>Currency</Label>
          <Input
            id={`${id}-currency`}
            value={currencyText}
            maxLength={3}
            onChange={(event) => setCurrencyText(event.currentTarget.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        {bound("At least", from, setFrom, "from")}
        {bound("At most", to, setTo, "to")}
      </div>
      {problem === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <Button size="sm" onClick={apply}>
        Apply
      </Button>
    </div>
  );
}

/** A day as the calendar holds it, from an ISO calendar day. */
const dayOf = (iso: string | undefined): Date | undefined => {
  if (iso === undefined || !isRecordsTableCalendarDay(iso)) return undefined;
  const [year, month, day] = iso.split("-").map(Number) as [number, number, number];
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return date;
};

/**
 * A date range of whole days, inclusive at both ends; either end may stay open. A date-and-time
 * field takes its days in the organisation's time zone, which the editor names.
 */
function DateEditor({
  field,
  applied,
  onCommit,
}: Readonly<{
  field: RecordsTableFilterField;
  applied: Extract<RecordsTableFieldFilter, { kind: "date" }> | undefined;
  onCommit: (filter: RecordsTableFieldFilter | undefined) => void;
}>): ReactElement {
  const id = useId();
  const [from, setFrom] = useState(applied?.from ?? "");
  const [to, setTo] = useState(applied?.to ?? "");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const apply = (): void => {
    if (from === "" && to === "") {
      setProblem(undefined);
      onCommit(undefined);
      return;
    }
    if (
      (from !== "" && !isRecordsTableCalendarDay(from)) ||
      (to !== "" && !isRecordsTableCalendarDay(to))
    ) {
      setProblem("Choose real calendar days.");
      return;
    }
    if (from !== "" && to !== "" && from > to) {
      setProblem("The first day must not be after the last day.");
      return;
    }
    setProblem(undefined);
    onCommit({ kind: "date", ...(from === "" ? {} : { from }), ...(to === "" ? {} : { to }) });
  };
  const fromDay = dayOf(from);
  const toDay = dayOf(to);
  return (
    <div className="flex flex-col gap-3">
      <Calendar
        mode="range"
        selected={fromDay === undefined ? undefined : { from: fromDay, to: toDay }}
        {...(fromDay === undefined ? {} : { defaultMonth: fromDay })}
        onSelect={(range) => {
          setFrom(range?.from === undefined ? "" : calendarDay(range.from));
          setTo(range?.to === undefined ? "" : calendarDay(range.to));
        }}
      />
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-from`}>From</Label>
          <Input
            id={`${id}-from`}
            type="date"
            value={from}
            onChange={(event) => setFrom(event.currentTarget.value)}
            onKeyDown={(event) => event.stopPropagation()}
            aria-invalid={problem !== undefined}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-to`}>Until</Label>
          <Input
            id={`${id}-to`}
            type="date"
            value={to}
            onChange={(event) => setTo(event.currentTarget.value)}
            onKeyDown={(event) => event.stopPropagation()}
            aria-invalid={problem !== undefined}
          />
        </div>
      </div>
      {field.timeZone === undefined ? null : (
        <p className="text-xs text-muted-foreground">Whole days in {field.timeZone}</p>
      )}
      {problem === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <Button size="sm" onClick={apply}>
        Apply
      </Button>
    </div>
  );
}

/**
 * A link filter: any of the chosen records. The picker reads one bounded page of the field's target
 * records under the viewer's access when it opens or is searched; nothing is preloaded.
 */
function LinkEditor({
  field,
  applied,
  narrowing,
  events,
  onCommit,
}: Readonly<{
  field: RecordsTableFilterField;
  applied: Extract<RecordsTableFieldFilter, { kind: "link" }> | undefined;
  narrowing: TableNarrowing | undefined;
  events: DisplayEventHandlers | undefined;
  onCommit: (filter: RecordsTableFieldFilter | undefined) => void;
}>): ReactElement {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [choices, setChoices] = useState<readonly RecordChoiceOption[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const generation = useRef(0);
  const incoming = JSON.stringify(applied?.recordIds ?? []);
  const [shown, setShown] = useState(incoming);
  const [chosen, setChosen] = useState<readonly string[]>(applied?.recordIds ?? []);
  if (shown !== incoming) {
    setShown(incoming);
    setChosen(applied?.recordIds ?? []);
  }
  const latestEvents = useRef(events);
  latestEvents.current = events;
  useEffect(() => {
    if (!open) {
      generation.current += 1;
      return;
    }
    const request = ++generation.current;
    const timeout = setTimeout(
      () => {
        const handler = latestEvents.current?.filter_records_requested;
        if (handler === undefined) return;
        setState("loading");
        const bounded = search.trim().slice(0, 100);
        void Promise.resolve(
          handler({
            event: "filter_records_requested",
            field: field.fieldId,
            ...(bounded === "" ? {} : { search: bounded }),
          }),
        )
          .then((answer) => {
            if (generation.current !== request) return;
            setChoices(parseRecordChoicePage(answer).choices);
            setState("idle");
          })
          .catch((cause: unknown) => {
            if (generation.current !== request) return;
            console.error("[column-filters] records unavailable", cause);
            setState("failed");
          });
      },
      search.trim() === "" ? 0 : TEXT_COMMIT_DELAY_MS,
    );
    return () => {
      clearTimeout(timeout);
      generation.current += 1;
    };
  }, [open, search, field.fieldId]);
  const remove = (recordId: string): void => {
    const next = chosen.filter((held) => held !== recordId);
    setChosen(next);
    onCommit(next.length === 0 ? undefined : { kind: "link", recordIds: next });
  };
  return (
    <div className="flex flex-col gap-3">
      {chosen.length === 0 ? null : (
        <ul className="flex flex-wrap gap-1" aria-label={`Chosen ${field.label} records`}>
          {chosen.map((recordId) => (
            <li key={recordId}>
              <Badge variant="secondary" className="gap-1 pe-0.5">
                {narrowing?.recordTitles?.[recordId] ?? "Restricted record"}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${narrowing?.recordTitles?.[recordId] ?? "record"}`}
                  onClick={() => remove(recordId)}
                >
                  <Icon name="close" aria-hidden="true" />
                </Button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <Combobox
        items={choices}
        value={null}
        inputValue={search}
        onOpenChange={(next: boolean) => {
          setOpen(next);
          if (!next) {
            setSearch("");
            setChoices([]);
          }
        }}
        onInputValueChange={(next: string) => setSearch(next)}
        onValueChange={(item: RecordChoiceOption | null) => {
          if (
            item === null ||
            chosen.includes(item.recordId.toLowerCase()) ||
            chosen.length >= RECORDS_TABLE_MAXIMUM_FILTER_RECORDS
          )
            return;
          const next = [...chosen, item.recordId.toLowerCase()];
          setChosen(next);
          onCommit({ kind: "link", recordIds: next });
        }}
        itemToStringLabel={(item: RecordChoiceOption) => item.title}
        itemToStringValue={(item: RecordChoiceOption) => item.recordId}
        // The server already searched; every record it returned is offered.
        filter={() => true}
      >
        <ComboboxInput
          placeholder={`Find ${field.label}`}
          aria-label={`Find ${field.label} records`}
          disabled={chosen.length >= RECORDS_TABLE_MAXIMUM_FILTER_RECORDS}
          onKeyDown={(event) => event.stopPropagation()}
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
        </ComboboxContent>
      </Combobox>
    </div>
  );
}

/** A yes/no filter: Yes or No commits at once; Any clears. */
function YesNoEditor({
  field,
  applied,
  onCommit,
}: Readonly<{
  field: RecordsTableFilterField;
  applied: Extract<RecordsTableFieldFilter, { kind: "yes_no" }> | undefined;
  onCommit: (filter: RecordsTableFieldFilter | undefined) => void;
}>): ReactElement {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{field.label}</Label>
      <NativeSelect
        id={id}
        value={applied === undefined ? "" : String(applied.value)}
        onChange={(event) => {
          const value = event.currentTarget.value;
          onCommit(value === "" ? undefined : { kind: "yes_no", value: value === "true" });
        }}
      >
        <NativeSelectOption value="">Any</NativeSelectOption>
        <NativeSelectOption value="true">Yes</NativeSelectOption>
        <NativeSelectOption value="false">No</NativeSelectOption>
      </NativeSelect>
    </div>
  );
}

/** The one editor of a field's filter kind, starting from the filter the shown page was read with. */
function FilterEditor({
  field,
  narrowing,
  events,
}: Readonly<{
  field: RecordsTableFilterField;
  narrowing: TableNarrowing | undefined;
  events: DisplayEventHandlers | undefined;
}>): ReactElement {
  const applied = appliedFilter(narrowing, field.fieldId);
  const rangeKey = applied === undefined ? "" : encodeRecordsTableFieldFilter(applied);
  const onCommit = (filter: RecordsTableFieldFilter | undefined): void =>
    commitFilter(events, field.fieldId, filter);
  const of = <Kind extends RecordsTableFieldFilter["kind"]>(kind: Kind) =>
    applied?.kind === kind
      ? (applied as Extract<RecordsTableFieldFilter, { kind: Kind }>)
      : undefined;
  switch (field.kind) {
    case "text":
      return <TextEditor field={field} applied={of("text")} onCommit={onCommit} />;
    case "choice":
      return <ChoiceEditor field={field} applied={of("choice")} onCommit={onCommit} />;
    case "number":
      return (
        <RangeEditor key={rangeKey} field={field} applied={of("number")} onCommit={onCommit} />
      );
    case "money":
      return <RangeEditor key={rangeKey} field={field} applied={of("money")} onCommit={onCommit} />;
    case "date":
      return <DateEditor key={rangeKey} field={field} applied={of("date")} onCommit={onCommit} />;
    case "link":
      return (
        <LinkEditor
          field={field}
          applied={of("link")}
          narrowing={narrowing}
          events={events}
          onCommit={onCommit}
        />
      );
    case "yes_no":
      return <YesNoEditor field={field} applied={of("yes_no")} onCommit={onCommit} />;
  }
}

const filterFieldOf = (
  context: GridFeaturePointProps["context"],
  fieldId: string,
): RecordsTableFilterField | undefined =>
  context.features.columnFilters?.find((field) => sameKey(field.fieldId, fieldId));

/**
 * The filter button after a filterable column's heading: it opens the field's typed filter in a
 * popover and shows when the column is filtered. It never starts a sort of the column.
 */
function ColumnFilterButton({ context, column }: GridFeatureColumnProps): ReactElement | null {
  const field = filterFieldOf(context, column.key);
  if (field === undefined || context.events?.filter_changed === undefined) return null;
  const active = appliedFilter(context.narrowing, field.fieldId) !== undefined;
  return (
    <span
      className="contents"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Popover>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <Button
                    variant={active ? "secondary" : "ghost"}
                    size="icon-xs"
                    aria-label={`Filter by ${field.label}${active ? " (filtered)" : ""}`}
                    aria-pressed={active}
                    className={active ? "text-primary" : "text-muted-foreground"}
                  />
                }
              />
            }
          >
            <Icon name="sliders-horizontal" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>Filter by {field.label}</TooltipContent>
        </Tooltip>
        <PopoverContent className="w-72" align="start">
          <PopoverTitle>{field.label}</PopoverTitle>
          <FilterEditor field={field} narrowing={context.narrowing} events={context.events} />
          {!active ? null : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => commitFilter(context.events, field.fieldId, undefined)}
            >
              Clear filter
            </Button>
          )}
        </PopoverContent>
      </Popover>
    </span>
  );
}

/**
 * The toolbar part of Column filters: one chip per committed filter with its remove button, a
 * "Filter" popover that reaches every filterable field (also those not shown as columns, and on
 * narrow screens where the grid shows cards), and "Clear filters".
 */
function FiltersToolbar({ context }: GridFeaturePointProps): ReactElement | null {
  const fields = context.features.columnFilters ?? [];
  const [chosenField, setChosenField] = useState<string | undefined>(undefined);
  const selectId = useId();
  if (fields.length === 0 || context.events?.filter_changed === undefined) return null;
  const active = fields.flatMap((field) => {
    const filter = appliedFilter(context.narrowing, field.fieldId);
    return filter === undefined ? [] : [{ field, filter }];
  });
  const editing =
    fields.find((field) => chosenField !== undefined && sameKey(field.fieldId, chosenField)) ??
    fields[0]!;
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label={`Filters for ${context.accessibleName}`}
    >
      <Popover>
        <PopoverTrigger render={<Button variant="outline" size="sm" />}>
          <Icon name="sliders-horizontal" aria-hidden="true" />
          Filter
        </PopoverTrigger>
        <PopoverContent className="w-72" align="start">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={selectId}>Field</Label>
            <NativeSelect
              id={selectId}
              value={editing.fieldId}
              onChange={(event) => setChosenField(event.currentTarget.value)}
            >
              {fields.map((field) => (
                <NativeSelectOption key={field.fieldId} value={field.fieldId}>
                  {field.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <FilterEditor
            key={editing.fieldId}
            field={editing}
            narrowing={context.narrowing}
            events={context.events}
          />
        </PopoverContent>
      </Popover>
      {active.map(({ field, filter }) => (
        <Badge key={field.fieldId} variant="secondary" className="gap-1 pe-0.5">
          <span className="font-medium">{field.label}:</span>
          <FilterSummary field={field} filter={filter} narrowing={context.narrowing} />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove the ${field.label} filter`}
            onClick={() => commitFilter(context.events, field.fieldId, undefined)}
          >
            <Icon name="close" aria-hidden="true" />
          </Button>
        </Badge>
      ))}
      {active.length === 0 ? null : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            for (const { field } of active) commitFilter(context.events, field.fieldId, undefined);
          }}
        >
          Clear filters
        </Button>
      )}
    </div>
  );
}

export const gridFeature: GridFeatureModule = {
  ToolbarItems: FiltersToolbar,
  HeaderAdornment: ColumnFilterButton,
};
