"use client";

import { useState } from "react";
import { Button } from "../components/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "../components/combobox";
import { InputGroup } from "../components/input-group";
import type { StudioFlowDraftChoices } from "./application-flow-step-form";
import { StudioReferencePicker } from "./studio-reference-picker";
import { Plus } from "lucide-react";
import { Label } from "../components/label";

export type StudioFlowStepChoice = Readonly<{ type: string; title: string; summary: string }>;

/** The one step picker, shared by the inspector and the canvas edge insertion. */
export function StudioFlowStepPicker({
  id,
  label,
  types,
  forms,
  disabled,
  onAdd,
  action,
}: Readonly<{
  id: string;
  label: string;
  types: readonly StudioFlowStepChoice[];
  forms: StudioFlowDraftChoices["forms"];
  disabled: boolean;
  onAdd: (type: string, formAlias?: string) => void;
  action: string;
}>) {
  const [chosen, setChosen] = useState<StudioFlowStepChoice | null>(null);
  const [formAlias, setFormAlias] = useState("");
  const needsForm = chosen?.type === "interface.show_form";
  if (types.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No kind of step can be added to this flow here.
      </p>
    );
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Combobox
        items={types}
        value={chosen}
        onValueChange={setChosen}
        disabled={disabled}
        itemToStringLabel={(entry) => entry.title}
        itemToStringValue={(entry) => entry.type}
      >
        <InputGroup>
          <ComboboxInput
            id={id}
            placeholder="Choose a kind of step…"
            aria-describedby={chosen === null ? undefined : `${id}-summary`}
          />
          <ComboboxTrigger aria-label="Show step types" />
        </InputGroup>
        <ComboboxContent>
          <ComboboxEmpty>No matching steps.</ComboboxEmpty>
          <ComboboxList>
            {(entry: StudioFlowStepChoice) => (
              <ComboboxItem key={entry.type} value={entry}>
                {entry.title}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {chosen === null ? null : (
        <p id={`${id}-summary`} className="text-sm text-muted-foreground">
          {chosen.summary}
        </p>
      )}
      {needsForm && <div className="space-y-1">
        <Label htmlFor={`${id}-form`}>Form to show</Label>
        <StudioReferencePicker id={`${id}-form`} disabled={disabled} value={formAlias} unset="Choose a form before adding the step"
          options={forms.map((form) => ({ value: form.alias, label: form.label }))} onChange={setFormAlias} />
      </div>}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={disabled || chosen === null || (needsForm && !forms.some((form) => form.alias === formAlias))}
        onClick={() => {
          if (chosen !== null) {
            onAdd(chosen.type, needsForm ? formAlias : undefined);
            setFormAlias("");
            setChosen(null);
          }
        }}
      >
        <Plus />
        {action}
      </Button>
    </div>
  );
}
