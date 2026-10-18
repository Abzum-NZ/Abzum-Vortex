"use client";
import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";

type Inputs = ApplicationSourceDocument["body"]["modules"][number]["actions"][number]["inputs"];
const types = [
  "text",
  "formatted_text",
  "whole_number",
  "decimal_number",
  "money",
  "yes_no",
  "date",
  "date_time",
  "record_reference",
  "organization_account_reference",
] as const;

export function StudioActionInputs({
  source,
  inputs,
  onChange,
}: Readonly<{
  source: ApplicationSourceDocument;
  inputs: Inputs;
  onChange: (inputs: Inputs) => void;
}>) {
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
      {inputs.map((input, index) => (
        <div key={index} className="space-y-2 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Input {index + 1}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onChange(inputs.filter((_, at) => at !== index))}
            >
              Remove input
            </Button>
          </div>
          <Label htmlFor={`action-input-key-${index}`}>Input key</Label>
          <Input
            id={`action-input-key-${index}`}
            value={input.key}
            required
            onChange={(event) => replace(index, { ...input, key: event.target.value })}
          />
          <Label htmlFor={`action-input-label-${index}`}>Input label</Label>
          <Input
            id={`action-input-label-${index}`}
            value={input.label}
            required
            maxLength={60}
            onChange={(event) => replace(index, { ...input, label: event.target.value })}
          />
          <Label htmlFor={`action-input-type-${index}`}>Value type</Label>
          <NativeSelect
            id={`action-input-type-${index}`}
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
            {types.map((type) => (
              <NativeSelectOption key={type} value={type}>
                {type.replaceAll("_", " ")}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <div className="flex items-center gap-2">
            <Checkbox
              id={`action-input-required-${index}`}
              checked={input.required}
              onCheckedChange={(checked) =>
                replace(index, { ...input, required: checked === true })
              }
            />
            <Label htmlFor={`action-input-required-${index}`}>Required</Label>
          </div>
          {input.type === "record_reference" && (
            <fieldset className="space-y-1">
              <legend className="text-sm">Permitted record types</legend>
              {records.map((record) => (
                <div className="flex items-center gap-2" key={record.key}>
                  <Checkbox
                    id={`input-${index}-${record.key}`}
                    checked={input.record_types.includes(record.key)}
                    onCheckedChange={(checked) =>
                      replace(index, {
                        ...input,
                        record_types:
                          checked === true
                            ? [...input.record_types, record.key]
                            : input.record_types.filter((key) => key !== record.key),
                      })
                    }
                  />
                  <Label htmlFor={`input-${index}-${record.key}`}>{record.label}</Label>
                </div>
              ))}
            </fieldset>
          )}
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={inputs.length >= 50}
        onClick={() => {
          let n = inputs.length + 1;
          while (inputs.some((input) => input.key === `input_${n}`)) n += 1;
          onChange([
            ...inputs,
            { key: `input_${n}`, label: `Input ${n}`, type: "text", required: true },
          ]);
        }}
      >
        Add input
      </Button>
    </fieldset>
  );
}
