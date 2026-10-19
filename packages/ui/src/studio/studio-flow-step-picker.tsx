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
import { NativeSelect, NativeSelectOption } from "../components/native-select";
import { Label } from "../components/label";
import { Textarea } from "../components/textarea";
import { flowTaskRegistry, type ConditionNode, type FlowFormula } from "@vortex/platform/schema";
import { StudioConditionControls } from "./condition-controls";
import { studioFlowConditionFormula, type StudioFlowConditionContext } from "./application-flow-condition";
import type { StudioFlowNewStepSettings } from "./application-flow-commands";

export type StudioFlowStepChoice = Readonly<{ type: string; title: string; summary: string }>;
export type StudioFlowStepPickerContext = Readonly<{
  condition: StudioFlowConditionContext;
  fields: readonly Readonly<{ value: string; label: string }>[];
}>;

/** The one step picker, shared by the inspector and the canvas edge insertion. */
export function StudioFlowStepPicker({
  id,
  label,
  types,
  forms,
  disabled,
  onAdd,
  action,
  context,
}: Readonly<{
  id: string;
  label: string;
  types: readonly StudioFlowStepChoice[];
  forms: StudioFlowDraftChoices["forms"];
  disabled: boolean;
  onAdd: (type: string, settings: StudioFlowNewStepSettings) => void;
  action: string;
  context: StudioFlowStepPickerContext;
}>) {
  const [chosen, setChosen] = useState<StudioFlowStepChoice | null>(null);
  const [formAlias, setFormAlias] = useState("");
  const [message, setMessage] = useState("");
  const [field, setField] = useState("");
  const [condition, setCondition] = useState<ConditionNode | undefined>(undefined);
  const [formula, setFormula] = useState<FlowFormula | undefined>(undefined);
  const needsForm = chosen?.type === "interface.show_form";
  const needsCondition = chosen?.type === "if";
  const needsField = chosen?.type === "rule.require";
  const definition = chosen === null ? undefined : flowTaskRegistry[chosen.type as keyof typeof flowTaskRegistry];
  const needsMessage = needsCondition || definition?.properties.message?.required === true;
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
        onValueChange={(next) => {
          setChosen(next); setMessage(""); setField(""); setCondition(undefined); setFormula(undefined);
        }}
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
        <NativeSelect id={`${id}-form`} disabled={disabled} value={formAlias} onChange={(event) => setFormAlias(event.target.value)}>
          <NativeSelectOption value="">Choose a form before adding the step</NativeSelectOption>
          {forms.map((form) => <NativeSelectOption key={form.alias} value={form.alias}>{form.label}</NativeSelectOption>)}
        </NativeSelect>
      </div>}
      {needsCondition && <StudioConditionControls {...(condition === undefined ? {} : { value: condition })} context={context.condition.controls}
        label="Condition" onChange={(next, validation) => {
          setCondition(next);
          setFormula(next !== undefined && validation.isValid ? studioFlowConditionFormula(next, context.condition) : undefined);
        }} />}
      {needsField && <div className="space-y-2">
        <Label htmlFor={`${id}-field`}>Field</Label>
        <NativeSelect id={`${id}-field`} value={field} disabled={disabled} onChange={(event) => setField(event.target.value)}>
          <NativeSelectOption value="">Choose a field</NativeSelectOption>
          {context.fields.map((entry) => <NativeSelectOption key={entry.value} value={entry.value}>{entry.label}</NativeSelectOption>)}
        </NativeSelect>
      </div>}
      {needsMessage && <div className="space-y-2">
        <Label htmlFor={`${id}-message`}>{needsCondition ? "Message in the Then branch" : "Message"}</Label>
        <Textarea id={`${id}-message`} value={message} disabled={disabled} onChange={(event) => setMessage(event.target.value)} />
        {needsCondition && <p className="text-sm text-muted-foreground">Starts the branch with a warning or message. Add other steps after it.</p>}
      </div>}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={disabled || chosen === null || (needsForm && !forms.some((form) => form.alias === formAlias)) ||
          (needsMessage && message.trim() === "") || (needsField && !context.fields.some((entry) => entry.value === field)) ||
          (needsCondition && formula === undefined)}
        onClick={() => {
          if (chosen !== null) {
            onAdd(chosen.type, {
              ...(needsForm ? { formAlias } : {}), ...(needsMessage ? { message: message.trim() } : {}),
              ...(needsField ? { field } : {}), ...(needsCondition && formula !== undefined ? { condition: formula } : {}),
            });
            setFormAlias("");
            setMessage(""); setField(""); setCondition(undefined); setFormula(undefined);
            setChosen(null);
          }
        }}
      >
        {action}
      </Button>
    </div>
  );
}
