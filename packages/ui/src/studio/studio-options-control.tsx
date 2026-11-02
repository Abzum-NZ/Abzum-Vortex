"use client";

import type { JsonValue } from "@vortex/platform/schema";
import { Badge } from "../components/badge";
import { StudioRemoveButton } from "./studio-icon-buttons";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "../components/combobox";

type Option = Readonly<{ value: string; label: string }>;

/** Labelled choice values, preserving removed selections until the author removes them. */
export function StudioOptionsControl({
  id,
  value,
  options,
  onChange,
  "aria-label": label,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
}: Readonly<{
  id: string;
  value: readonly JsonValue[];
  options: readonly Option[];
  onChange: (value: JsonValue[]) => void;
  "aria-label": string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}>) {
  const anchor = useComboboxAnchor();
  const selected = options.filter((option) => value.includes(option.value));
  const unknown = value.filter((entry) => !options.some((option) => option.value === entry));
  const commit = (keys: readonly string[], removedIndex?: number) =>
    onChange([
      ...options.filter((option) => keys.includes(option.value)).map((option) => option.value),
      ...unknown.filter((_, index) => index !== removedIndex),
    ]);

  return (
    <div className="flex min-w-0 flex-col gap-2 text-foreground">
      {unknown.map((_, index) => (
        <div key={index} className="flex min-w-0 flex-wrap items-center gap-1">
          <Badge variant="destructive" className="max-w-full whitespace-normal">
            Unknown option (removed)
          </Badge>
          <StudioRemoveButton
            label="Remove unknown option"
            onClick={() =>
              commit(
                selected.map((option) => option.value),
                index,
              )
            }
          />
        </div>
      ))}
      <Combobox
        multiple
        items={options}
        value={selected}
        onValueChange={(next: Option[]) => commit(next.map((option) => option.value))}
        itemToStringLabel={(option: Option) => option.label}
        itemToStringValue={(option: Option) => option.value}
        isItemEqualToValue={(option, chosen) => option.value === chosen.value}
      >
        <ComboboxChips ref={anchor}>
          <ComboboxValue>
            {(chosen: Option[]) => (
              <>
                {chosen.map((option) => (
                  <ComboboxChip key={option.value} removeLabel={`Remove ${option.label}`}>
                    {option.label}
                  </ComboboxChip>
                ))}
                <ComboboxChipsInput
                  id={id}
                  aria-label={label}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder={chosen.length === 0 ? "Search options…" : ""}
                />
              </>
            )}
          </ComboboxValue>
        </ComboboxChips>
        <ComboboxContent anchor={anchor}>
          <ComboboxEmpty>No matching options.</ComboboxEmpty>
          <ComboboxList>
            {(option: Option) => (
              <ComboboxItem key={option.value} value={option}>
                {option.label}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}
