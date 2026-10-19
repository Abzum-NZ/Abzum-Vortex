"use client";
import { useRef } from "react";
import { deriveFieldKey, type ApplicationSourceDocument } from "@vortex/platform/schema";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@vortex/ui/components/combobox";
import { Input } from "@vortex/ui/components/input";
import { InputGroup, InputGroupAddon } from "@vortex/ui/components/input-group";
import { Label } from "@vortex/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import { StudioEntryList, useStudioEntryKeys } from "@vortex/ui/studio";

type Inputs = ApplicationSourceDocument["body"]["modules"][number]["actions"][number]["inputs"];
const typeLabels = {
  text: "Text",
  formatted_text: "Formatted text",
  whole_number: "Whole number",
  decimal_number: "Number",
  money: "Money",
  yes_no: "Yes or no",
  date: "Date",
  date_time: "Date and time",
  record_reference: "A record",
  organization_account_reference: "A person",
} satisfies Record<Inputs[number]["type"], string>;

export function StudioActionInputs({
  source,
  inputs,
  onChange,
  onRename,
}: Readonly<{
  source: ApplicationSourceDocument;
  inputs: Inputs;
  onChange: (inputs: Inputs) => void;
  onRename: (before: string, after: string) => void;
}>) {
  // Saved keys identify inputs in callers. Only new inputs derive their key as the label is edited.
  const { keys, newKey } = useStudioEntryKeys(inputs.length);
  const savedRows = useRef(new Set(keys.current));
  const records = source.body.modules.flatMap((module) =>
    module.record_types.map((record) => ({
      key: `${module.key}:${record.key}`,
      label: `${record.name} (${module.name})`,
    })),
  );
  const replace = (index: number, input: Inputs[number]) =>
    onChange(inputs.map((entry, at) => (at === index ? input : entry)));
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Inputs</legend>
      <StudioEntryList
        label="Action inputs"
        itemName="input"
        empty="No inputs yet."
        onMove={(from, to) => {
          const next = [...inputs];
          next.splice(to, 0, next.splice(from, 1)[0]!);
          keys.current.splice(to, 0, keys.current.splice(from, 1)[0]!);
          onChange(next);
        }}
        onRemove={(index) => {
          keys.current.splice(index, 1);
          onChange(inputs.filter((_, at) => at !== index));
        }}
        items={inputs.map((input, index) => {
          const id = `action-input-${keys.current[index]}`;
          return {
            key: keys.current[index]!,
            title: input.label || "Unnamed input",
            summary: `${typeLabels[input.type]} · ${input.required ? "Required" : "Optional"}`,
            content: (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor={`${id}-label`}>Label</Label>
                  <Input
                    id={`${id}-label`}
                    value={input.label}
                    required
                    maxLength={60}
                    onChange={(event) => {
                      const label = event.target.value;
                      const key = savedRows.current.has(keys.current[index]!)
                        ? input.key
                        : (deriveFieldKey(
                            label,
                            new Set([
                              "record",
                              ...inputs.filter((_, at) => at !== index).map((entry) => entry.key),
                            ]),
                          ) ?? input.key);
                      replace(index, { ...input, label, key });
                      if (key !== input.key) onRename(input.key, key);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${id}-type`}>Value type</Label>
                  <NativeSelect
                    id={`${id}-type`}
                    className="w-full"
                    value={input.type}
                    onChange={(event) => {
                      const type = event.target.value as Inputs[number]["type"];
                      replace(index, {
                        key: input.key,
                        label: input.label,
                        required: input.required,
                        type,
                        ...(type === "record_reference"
                          ? { record_types: records[0] === undefined ? [] : [records[0].key] }
                          : {}),
                      } as Inputs[number]);
                    }}
                  >
                    {Object.entries(typeLabels).map(([type, label]) => (
                      <NativeSelectOption key={type} value={type}>
                        {label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`${id}-required`}
                    checked={input.required}
                    onCheckedChange={(checked) =>
                      replace(index, { ...input, required: checked === true })
                    }
                  />
                  <Label htmlFor={`${id}-required`}>Required</Label>
                </div>
                {input.type === "record_reference" && (
                  <div className="space-y-2">
                    <Label htmlFor={`${id}-records`}>Permitted record types</Label>
                    <Combobox
                      multiple
                      items={records}
                      value={records.filter((record) => input.record_types.includes(record.key))}
                      itemToStringLabel={(record) => record.label}
                      itemToStringValue={(record) => record.key}
                      isItemEqualToValue={(record, selected) => record.key === selected.key}
                      onValueChange={(selected) =>
                        replace(index, {
                          ...input,
                          record_types: selected.map((record) => record.key),
                        })
                      }
                    >
                      <InputGroup>
                        <ComboboxInput id={`${id}-records`} placeholder="Search record types…" />
                        <InputGroupAddon align="inline-end">
                          <ComboboxTrigger aria-label="Show record types" />
                        </InputGroupAddon>
                      </InputGroup>
                      <ComboboxContent>
                        <ComboboxEmpty>No matching record types.</ComboboxEmpty>
                        <ComboboxList>
                          {(record: (typeof records)[number]) => (
                            <ComboboxItem key={record.key} value={record}>
                              {record.label}
                            </ComboboxItem>
                          )}
                        </ComboboxList>
                      </ComboboxContent>
                    </Combobox>
                    <p className="text-sm text-muted-foreground" aria-live="polite">
                      {input.record_types.length === 0
                        ? "Choose at least one record type."
                        : input.record_types
                            .map(
                              (key) => records.find((record) => record.key === key)?.label ?? key,
                            )
                            .join(", ")}
                    </p>
                  </div>
                )}
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground">Details</summary>
                  <div className="space-y-1 pt-2">
                    <p>
                      Input key: <code className="font-mono text-xs">{input.key}</code>
                    </p>
                    <p className="text-muted-foreground">
                      Created from the label and kept after saving so other steps can use it.
                    </p>
                  </div>
                </details>
              </div>
            ),
          };
        })}
      >
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={inputs.length >= 50}
          onClick={() => {
            let n = inputs.length + 1;
            while (inputs.some((input) => input.key === `input_${n}`)) n += 1;
            keys.current.push(newKey());
            onChange([
              ...inputs,
              { key: `input_${n}`, label: `Input ${n}`, type: "text", required: true },
            ]);
          }}
        >
          <Icon name="plus" /> Add input
        </Button>
      </StudioEntryList>
    </fieldset>
  );
}
