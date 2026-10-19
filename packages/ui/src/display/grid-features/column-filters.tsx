"use client";

import { useId, useState, type ReactElement } from "react";
import type { RecordsTableColumnContract } from "@vortex/platform/schema";
import { Icon } from "../../icons/icon";
import { Button } from "../../components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../components/dropdown-menu";
import { Input } from "../../components/input";
import { Label } from "../../components/label";
import type { DisplayEventHandlers } from "../projected-data";
import type { GridFeatureModule, GridFeaturePointProps } from "./registry";

/** The closed input kinds a declared filterable field's control can take. */
type FilterInputKind = "text" | "number" | "date" | "boolean";

/** The three closed values a yes/no filter commits, and the label each one shows. */
const BOOLEAN_FILTER_OPTIONS = [
  { value: "", label: "Any" },
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
] as const;

/**
 * A yes/no filter as a Dropdown Menu of its three closed values, keeping the committed value as the
 * trigger's label and in its accessible name. It reports only a real change, exactly as the native
 * choice list did.
 */
function BooleanFilterControl({
  id,
  label,
  value,
  onCommit,
}: Readonly<{
  id: string;
  label: string;
  value: string;
  onCommit: (next: string) => void;
}>): ReactElement {
  const current = (
    BOOLEAN_FILTER_OPTIONS.find((option) => option.value === value) ?? BOOLEAN_FILTER_OPTIONS[0]
  ).label;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            id={id}
            variant="outline"
            size="default"
            aria-label={`Filter by ${label}: ${current}`}
            className="w-full justify-between"
          />
        }
      >
        {current}
        <Icon name="chevron-down" data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup value={value} onValueChange={(next: string) => onCommit(next)}>
          {BOOLEAN_FILTER_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} closeOnClick>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One filter control for a configured filterable field. It emits the declared `filter_changed`
 * event for its field; the host sends that to the Query engine and returns a new page, so the
 * component never filters the returned rows itself. It only reports a committed value: a text or
 * number filter commits on Enter or blur, while a date or yes/no filter commits on change.
 */
function FilterControl({
  field,
  label,
  input,
  initialValue,
  events,
}: Readonly<{
  field: string;
  label: string;
  input: FilterInputKind;
  /** The value the shown page was filtered by; empty when this field is not filtered. */
  initialValue: string;
  events: DisplayEventHandlers | undefined;
}>): ReactElement | null {
  const [value, setValue] = useState(initialValue);
  const [committed, setCommitted] = useState(initialValue);
  const [appliedValue, setAppliedValue] = useState(initialValue);
  if (appliedValue !== initialValue) {
    setAppliedValue(initialValue);
    setValue(initialValue);
    setCommitted(initialValue);
  }
  const inputId = useId();
  const onFilter = events?.filter_changed;
  if (onFilter === undefined) return null;
  // Reports only a real change, never each keystroke or a blur that changed nothing.
  const emit = (next: string): void => {
    if (next === committed) return;
    setCommitted(next);
    onFilter({ event: "filter_changed", field, value: next });
  };
  const control = ((): ReactElement => {
    switch (input) {
      case "boolean":
        return (
          <BooleanFilterControl
            id={inputId}
            label={label}
            value={value}
            onCommit={(next) => {
              setValue(next);
              emit(next);
            }}
          />
        );
      case "date":
        return (
          <Input
            id={inputId}
            type="date"
            aria-label={`Filter by ${label}`}
            value={value}
            onChange={(event) => {
              setValue(event.currentTarget.value);
              emit(event.currentTarget.value);
            }}
          />
        );
      case "number":
        return (
          <Input
            id={inputId}
            type="number"
            aria-label={`Filter by ${label}`}
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
            onBlur={() => emit(value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                emit(value);
              }
            }}
          />
        );
      default:
        return (
          <Input
            id={inputId}
            type="search"
            aria-label={`Filter by ${label}`}
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
            onBlur={() => emit(value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                emit(value);
              }
            }}
          />
        );
    }
  })();
  return (
    <div className="flex min-w-32 flex-col gap-1">
      <Label htmlFor={inputId}>{label}</Label>
      {control}
    </div>
  );
}

/** The filter control kind for a filterable field, from the column it is declared with. */
const filterInputKind = (declared: RecordsTableColumnContract): FilterInputKind => {
  switch (declared.format) {
    case "number":
    case "currency":
    case "percent":
      return "number";
    case "date":
    case "date_time":
      return "date";
    case "boolean":
      return "boolean";
    default:
      return "text";
  }
};

/**
 * Column filters: one control for each field the projection lets this viewer filter by that the page
 * carries as a column. A field withheld from the viewer has no carried column, so it gets no
 * control and its identity is never shown as a label.
 */
function FiltersToolbar({ context }: GridFeaturePointProps): ReactElement | null {
  const fields = context.features.columnFilters ?? [];
  const columns = context.columns.filter((column) =>
    fields.some((field) => field.toLowerCase() === column.key.toLowerCase()),
  );
  if (columns.length === 0 || context.events?.filter_changed === undefined) return null;
  const filterValue = (key: string): string =>
    context.narrowing?.filters.find((filter) => filter.fieldId.toLowerCase() === key.toLowerCase())
      ?.value ?? "";
  return (
    <div
      className="flex flex-wrap gap-2"
      role="group"
      aria-label={`Filters for ${context.accessibleName}`}
    >
      {columns.map((column) => (
        <FilterControl
          key={column.key}
          field={column.key}
          label={column.label}
          input={filterInputKind(column.declared)}
          initialValue={filterValue(column.key)}
          events={context.events}
        />
      ))}
    </div>
  );
}

export const gridFeature: GridFeatureModule = { ToolbarItems: FiltersToolbar };
