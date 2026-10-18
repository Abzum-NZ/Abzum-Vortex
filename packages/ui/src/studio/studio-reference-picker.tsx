"use client";
import { useState } from "react";
import { Combobox as Primitive } from "@base-ui/react/combobox";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "../components/combobox";
import { InputGroup, InputGroupAddon } from "../components/input-group";

export type StudioReferencePickerOption = Readonly<{
  value: string;
  label: string;
  group?: string | undefined;
  description?: string | undefined;
  disabled?: boolean | undefined;
}>;

/** Search authored references without dropping an unavailable current selection. */
export function StudioReferencePicker({
  id,
  value,
  options,
  unset,
  disabled,
  onChange,
  ...accessibility
}: Readonly<{
  id?: string;
  value: string;
  options: readonly StudioReferencePickerOption[];
  unset?: string | undefined;
  disabled?: boolean;
  onChange: (value: string) => void;
  "aria-label"?: string;
  "aria-describedby"?: string | undefined;
  "aria-invalid"?: boolean;
}>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const known = value === "" || options.some((option) => option.value === value);
  const entries: StudioReferencePickerOption[] = [
    ...(unset === undefined ? [] : [{ value: "", label: unset }]),
    ...(!known ? [{ value, label: value + " (not offered here)", disabled: true }] : []),
    ...options,
  ];
  const selected = entries.find((entry) => entry.value === value) ?? null;
  const matches = entries.filter((entry) =>
    [entry.label, entry.group, entry.description]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const groups = [...new Set(matches.map((entry) => entry.group ?? ""))];
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
      onInputValueChange={(text, details) => {
        if (details.reason === "input-change" || details.reason === "input-clear") setQuery(text);
      }}
      filter={null}
      disabled={disabled}
      itemToStringLabel={(entry: StudioReferencePickerOption) => entry.label}
      itemToStringValue={(entry: StudioReferencePickerOption) => entry.value}
      isItemEqualToValue={(entry, selected) => entry.value === selected.value}
      onValueChange={(entry) => {
        if (entry !== null && !entry.disabled) onChange(entry.value);
      }}
    >
      <InputGroup>
        <ComboboxInput
          id={id}
          placeholder={unset ?? "Search…"}
          {...accessibility}
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
            <Primitive.Group
              key={group}
              items={matches.filter((entry) => (entry.group ?? "") === group)}
            >
              {group !== "" && (
                <Primitive.GroupLabel className="px-3 py-2 text-xs font-medium text-muted-foreground">
                  {group}
                </Primitive.GroupLabel>
              )}
              <Primitive.Collection>
                {(entry: StudioReferencePickerOption) => (
                  <ComboboxItem key={entry.value} value={entry} disabled={entry.disabled}>
                    <span className="flex flex-col text-sm">
                      <span>{entry.label}</span>
                      {entry.description !== undefined && (
                        <span className="text-muted-foreground">{entry.description}</span>
                      )}
                    </span>
                  </ComboboxItem>
                )}
              </Primitive.Collection>
            </Primitive.Group>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
