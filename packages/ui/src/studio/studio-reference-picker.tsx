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
  ...accessibility
}: Readonly<{
  id?: string | undefined;
  value: string;
  options: readonly StudioReferencePickerOption[];
  unset?: string | undefined;
  disabled?: boolean;
  onChange: (value: string) => void;
  "aria-label"?: string | undefined;
  "aria-describedby"?: string | undefined;
  "aria-invalid"?: boolean | undefined;
}>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const known = value === "" || options.some((option) => option.value === value);
  const entries: StudioReferencePickerOption[] = [
    ...(unset === undefined ? [] : [{ value: "", label: unset }]),
    ...(!known ? [{ value, label: "A removed item", disabled: true }] : []),
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
              </Primitive.Collection>
            </Primitive.Group>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
