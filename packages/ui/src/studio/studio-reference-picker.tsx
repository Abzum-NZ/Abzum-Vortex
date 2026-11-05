"use client";
import { useState } from "react";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
} from "../components/combobox";
import { InputGroup, InputGroupAddon } from "../components/input-group";
import { Badge } from "../components/badge";
import { Lock } from "lucide-react";

export type StudioReferencePickerOption = Readonly<{
  value: string;
  label: string;
  group?: string | undefined;
  description?: string | undefined;
  disabled?: boolean | undefined;
  /** Chosen as it is: it belongs to another application and is changed there. */
  readOnly?: boolean | undefined;
}>;

/** The group of a choice owned by another application: named by that application, read-only. */
export const studioBorrowedGroup = (application: string): string =>
  `From ${application} (read-only)`;

/** Search authored references without dropping an unavailable current selection. */
export function StudioReferencePicker({
  id,
  value,
  options,
  unset,
  disabled,
  onChange,
  onSearch,
  ...accessibility
}: Readonly<{
  id?: string | undefined;
  value: string;
  options: readonly StudioReferencePickerOption[];
  unset?: string | undefined;
  disabled?: boolean;
  onChange: (value: string) => void;
  /**
   * The search text as it is typed. A picker that passes it shows `options` as given: the caller
   * searches them (a long list read page by page) instead of this picker filtering the loaded ones.
   */
  onSearch?: ((text: string) => void) | undefined;
  "aria-label"?: string | undefined;
  "aria-describedby"?: string | undefined;
  "aria-invalid"?: boolean | undefined;
}>) {
  const [open, setOpen] = useState(false);
  const [query, setSearchText] = useState("");
  const setQuery = (text: string): void => {
    setSearchText(text);
    onSearch?.(text);
  };
  const known = value === "" || options.some((option) => option.value === value);
  const entries: StudioReferencePickerOption[] = [
    ...(unset === undefined ? [] : [{ value: "", label: unset }]),
    ...(!known ? [{ value, label: "A removed item", disabled: true }] : []),
    ...options,
  ];
  const selected = entries.find((entry) => entry.value === value) ?? null;
  const searching = query.trim() !== "";
  const matches =
    onSearch === undefined
      ? entries.filter((entry) =>
          [entry.label, entry.group, entry.description]
            .join(" ")
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase()),
        )
      : entries.filter((entry) => !searching || entry.value !== "");
  const groups = [...new Set(matches.map((entry) => entry.group ?? ""))];
  // The search text is empty whenever the list is open: what is shown before typing is the
  // current selection, its label as the placeholder and its check in the list, never text the
  // person has to clear.
  const startSearch = () => {
    if (open) return;
    setQuery("");
    setOpen(true);
  };
  return (
    <Combobox
      items={groups.flatMap((group) => matches.filter((entry) => (entry.group ?? "") === group))}
      value={selected}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      inputValue={open ? query : (selected?.label ?? "")}
      onInputValueChange={(text) => setQuery(text)}
      filter={null}
      disabled={disabled}
      itemToStringLabel={(entry: StudioReferencePickerOption) => entry.label}
      itemToStringValue={(entry: StudioReferencePickerOption) => entry.value}
      isItemEqualToValue={(entry, selected) => entry.value === selected.value}
      onValueChange={(entry) => {
        // Choosing the option already held changes nothing, so it sends nothing.
        if (entry !== null && !entry.disabled && entry.value !== value) onChange(entry.value);
      }}
    >
      <InputGroup>
        <ComboboxInput
          id={id}
          placeholder={selected?.label ?? "Search…"}
          {...accessibility}
          onFocus={startSearch}
          onPointerDown={startSearch}
          aria-invalid={accessibility["aria-invalid"] || !known}
        />
        <InputGroupAddon align="inline-end">
          <ComboboxTrigger aria-label="Show choices" />
        </InputGroupAddon>
      </InputGroup>
      <ComboboxContent>
        <ComboboxEmpty>No matching choices.</ComboboxEmpty>
        <ComboboxList>
          {groups.map((group) => (
            <ComboboxGroup
              key={group}
              items={matches.filter((entry) => (entry.group ?? "") === group)}
            >
              {group !== "" && <ComboboxLabel>{group}</ComboboxLabel>}
              <ComboboxCollection>
                {(entry: StudioReferencePickerOption) => (
                  <ComboboxItem key={entry.value} value={entry} disabled={entry.disabled}>
                    <span className="flex min-w-0 flex-1 flex-col text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate">{entry.label}</span>
                        {entry.readOnly === true && (
                          <Badge variant="secondary" className="shrink-0 gap-1">
                            <Lock className="size-3" />
                            Read-only
                          </Badge>
                        )}
                      </span>
                      {entry.description !== undefined && (
                        <span className="line-clamp-1 text-muted-foreground">
                          {entry.description}
                        </span>
                      )}
                    </span>
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
