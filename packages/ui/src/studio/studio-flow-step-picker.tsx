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
import { StudioReferencePicker } from "./studio-reference-picker";
import { Plus } from "lucide-react";
import { Label } from "../components/label";
import { Textarea } from "../components/textarea";
import { flowTaskRegistry, type ConditionNode, type FlowFormula } from "@vortex/platform/schema";
import { StudioConditionControls } from "./condition-controls";
import {
  studioFlowConditionFormula,
  type StudioFlowConditionContext,
} from "./application-flow-condition";
import type { StudioFlowNewStepSettings, StudioFlowStepType } from "./application-flow-commands";

export type StudioFlowStepChoice = StudioFlowStepType;
export type StudioFlowStepPickerContext = Readonly<{
  condition: StudioFlowConditionContext;
  fields: readonly Readonly<{ value: string; label: string }>[];
}>;

/** The one step picker, shared by the inspector and the canvas edge insertion. */
export function StudioFlowStepPicker({
  id,
  label,
  types,
  disabled,
  onAdd,
  action,
  context,
}: Readonly<{
  id: string;
  label: string;
  types: readonly StudioFlowStepChoice[];
  disabled: boolean;
  onAdd: (type: string, settings: StudioFlowNewStepSettings) => boolean;
  action: string;
  context: StudioFlowStepPickerContext;
}>) {
  const [chosen, setChosen] = useState<StudioFlowStepChoice | null>(null);
  const [picks, setPicks] = useState<Readonly<Record<string, string>>>({});
  const [message, setMessage] = useState("");
  const [field, setField] = useState("");
  const [condition, setCondition] = useState<ConditionNode | undefined>(undefined);
  const [formula, setFormula] = useState<FlowFormula | undefined>(undefined);
  const [thenTaskType, setThenTaskType] = useState("");
  const choices = chosen?.choices ?? [];
  const needsCondition = chosen?.type === "if";
  const needsField = chosen?.type === "rule.require";
  const definition =
    chosen === null ? undefined : flowTaskRegistry[chosen.type as keyof typeof flowTaskRegistry];
  const branchTypes = types.filter((entry) =>
    ["rule.warn", "interface.show_message", "stop"].includes(entry.type),
  );
  const needsMessage =
    (needsCondition && thenTaskType !== "" && thenTaskType !== "stop") ||
    definition?.properties.message?.required === true;
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
          setChosen(next);
          setPicks({});
          setMessage("");
          setField("");
          setCondition(undefined);
          setFormula(undefined);
          setThenTaskType("");
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
      {choices.map((choice) => (
        <div key={choice.property} className="space-y-1">
          <Label htmlFor={`${id}-${choice.property}`}>{choice.label}</Label>
          <StudioReferencePicker
            id={`${id}-${choice.property}`}
            disabled={disabled}
            value={picks[choice.property] ?? ""}
            unset={choice.unset}
            options={choice.options}
            onChange={(next) => setPicks({ ...picks, [choice.property]: next })}
          />
        </div>
      ))}
      {needsCondition && (
        <StudioConditionControls
          {...(condition === undefined ? {} : { value: condition })}
          context={context.condition.controls}
          label="Condition"
          onChange={(next, validation) => {
            setCondition(next);
            setFormula(
              next !== undefined && validation.isValid
                ? studioFlowConditionFormula(next, context.condition)
                : undefined,
            );
          }}
        />
      )}
      {needsCondition && (
        <div className="space-y-2">
          <Label htmlFor={`${id}-then`}>First step in Then</Label>
          <StudioReferencePicker
            id={`${id}-then`}
            value={thenTaskType}
            disabled={disabled}
            unset="Choose a step"
            options={branchTypes.map((entry) => ({ value: entry.type, label: entry.title }))}
            onChange={setThenTaskType}
          />
          {thenTaskType === "stop" && (
            <p className="text-sm text-muted-foreground">
              Ends the flow when the condition matches.
            </p>
          )}
        </div>
      )}
      {needsField && (
        <div className="space-y-2">
          <Label htmlFor={`${id}-field`}>Field</Label>
          <StudioReferencePicker
            id={`${id}-field`}
            value={field}
            disabled={disabled}
            unset="Choose a field"
            options={context.fields}
            onChange={setField}
          />
        </div>
      )}
      {needsMessage && (
        <div className="space-y-2">
          <Label htmlFor={`${id}-message`}>
            {needsCondition ? "Message in the Then branch" : "Message"}
          </Label>
          <Textarea
            id={`${id}-message`}
            value={message}
            disabled={disabled}
            onChange={(event) => setMessage(event.target.value)}
          />
        </div>
      )}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={
          disabled ||
          chosen === null ||
          choices.some(
            (choice) => !choice.options.some((option) => option.value === picks[choice.property]),
          ) ||
          (needsMessage && message.trim() === "") ||
          (needsField && !context.fields.some((entry) => entry.value === field)) ||
          (needsCondition &&
            (formula === undefined || !branchTypes.some((entry) => entry.type === thenTaskType)))
        }
        onClick={() => {
          if (chosen !== null) {
            const added = onAdd(chosen.type, {
              ...(choices.length > 0 ? { choices: picks } : {}),
              ...(needsMessage ? { message: message.trim() } : {}),
              ...(needsField ? { field } : {}),
              ...(needsCondition && formula !== undefined
                ? { condition: formula, thenTaskType }
                : {}),
            });
            if (!added) return;
            setPicks({});
            setMessage("");
            setField("");
            setCondition(undefined);
            setFormula(undefined);
            setThenTaskType("");
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
