"use client";

import { useState, type ReactNode } from "react";
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
import { Input } from "../components/input";
import {
  flowMaximumForEachItemsOther,
  flowMaximumTaskNestingDepth,
  flowTaskRegistry,
  type ConditionNode,
  type FlowFormula,
  type FlowLiteral,
  type FlowValue,
  type SourceFlow,
} from "@vortex/platform/schema";
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
  flows?: readonly SourceFlow[];
  renderExpression?: (
    props: Readonly<{
      id: string;
      value: FlowFormula;
      onChange: (value: FlowFormula | undefined, type: string | undefined) => void;
    }>,
  ) => ReactNode;
  renderValue?: (
    props: Readonly<{
      id: string;
      label: string;
      type: string | undefined;
      value: FlowValue | null;
      onChange: (value: FlowValue | null) => void;
    }>,
  ) => ReactNode;
  renderLiteral?: (
    props: Readonly<{
      id: string;
      label: string;
      type: string | undefined;
      value: FlowLiteral | null;
      onChange: (value: FlowLiteral) => void;
    }>,
  ) => ReactNode;
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
  depth = 0,
}: Readonly<{
  id: string;
  label: string;
  types: readonly StudioFlowStepChoice[];
  disabled: boolean;
  onAdd: (type: string, settings: StudioFlowNewStepSettings) => boolean;
  action: string;
  context: StudioFlowStepPickerContext;
  depth?: number;
}>) {
  const [chosen, setChosen] = useState<StudioFlowStepChoice | null>(null);
  const [picks, setPicks] = useState<Readonly<Record<string, string>>>({});
  const [message, setMessage] = useState("");
  const [field, setField] = useState("");
  const [condition, setCondition] = useState<ConditionNode | undefined>(undefined);
  const [formula, setFormula] = useState<FlowFormula | undefined>(undefined);
  const [expression, setExpression] = useState<FlowFormula | undefined>(undefined);
  const [expressionType, setExpressionType] = useState<string | undefined>(undefined);
  const [caseValue, setCaseValue] = useState<FlowLiteral | null>(null);
  const [maximumItems, setMaximumItems] = useState(flowMaximumForEachItemsOther);
  const [target, setTarget] = useState("");
  const [inputs, setInputs] = useState<Readonly<Record<string, FlowValue>>>({});
  const [firstStep, setFirstStep] = useState<
    Readonly<{ type: string; settings: StudioFlowNewStepSettings }> | undefined
  >(undefined);
  const selectedFlow = context.flows?.find((flow) => flow.id === target || flow.key === target);
  const requiredInputs = Object.entries(selectedFlow?.inputs ?? {}).filter(
    ([, input]) => input.required,
  );
  const grouped =
    chosen?.type === "if" ||
    chosen?.type === "switch" ||
    chosen?.type === "for_each" ||
    chosen?.type === "sequential";
  const needsExpression = chosen?.type === "switch" || chosen?.type === "for_each";
  const choices = chosen?.choices ?? [];
  const needsCondition = chosen?.type === "if";
  const needsField = chosen?.type === "rule.require";
  const definition =
    chosen === null ? undefined : flowTaskRegistry[chosen.type as keyof typeof flowTaskRegistry];
  const needsMessage = definition?.properties.message?.required === true;
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
          setExpression(undefined);
          setExpressionType(undefined);
          setCaseValue(null);
          setTarget("");
          setInputs({});
          setFirstStep(undefined);
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
      {needsExpression && (
        <div className="space-y-1">
          <Label htmlFor={`${id}-expression`}>
            {chosen?.type === "for_each" ? "List expression" : "Value expression"}
          </Label>
          {context.renderExpression?.({
            id: `${id}-expression`,
            value: expression ?? { op: "literal", type: "whole_number", value: 0 },
            onChange: (value, type) => {
              setExpression(value);
              if (type !== expressionType) setCaseValue(null);
              setExpressionType(type);
            },
          })}
        </div>
      )}
      {chosen?.type === "switch" && (
        <div className="space-y-1">
          <Label htmlFor={`${id}-case`}>Case value</Label>
          {context.renderLiteral?.({
            id: `${id}-case`,
            label: "Case value",
            type: expressionType,
            value: caseValue,
            onChange: setCaseValue,
          })}
        </div>
      )}
      {chosen?.type === "for_each" && (
        <div className="space-y-1">
          <Label htmlFor={`${id}-maximum`}>Maximum items</Label>
          <Input
            id={`${id}-maximum`}
            type="number"
            min={1}
            max={flowMaximumForEachItemsOther}
            value={maximumItems}
            disabled={disabled}
            onChange={(event) => setMaximumItems(Number(event.target.value))}
          />
        </div>
      )}
      {chosen?.type === "run_flow" && (
        <div className="space-y-2">
          <Label htmlFor={`${id}-flow`}>Flow to run</Label>
          <StudioReferencePicker
            id={`${id}-flow`}
            value={target}
            disabled={disabled}
            unset="Choose a flow"
            options={(context.flows ?? []).map((flow) => ({
              value: flow.id,
              label: flow.labels?.name ?? flow.key,
            }))}
            onChange={(value) => {
              setTarget(value);
              setInputs({});
            }}
          />
          {requiredInputs.map(([name, input]) =>
            context.renderValue?.({
              id: `${id}-input-${name}`,
              label: name,
              type: input.type,
              value: inputs[name] ?? null,
              onChange: (value) =>
                setInputs((previous) => {
                  const next = { ...previous };
                  if (value === null) delete next[name];
                  else next[name] = value;
                  return next;
                }),
            }),
          )}
        </div>
      )}
      {grouped && (
        <div className="space-y-2">
          <p className="text-sm font-medium">First step</p>
          {firstStep === undefined ? (
            <StudioFlowStepPicker
              id={`${id}-first`}
              label="Kind of first step"
              types={
                depth + 1 >= flowMaximumTaskNestingDepth
                  ? types.filter(
                      (entry) => !["if", "switch", "for_each", "sequential"].includes(entry.type),
                    )
                  : types
              }
              disabled={disabled}
              action="Choose first step"
              context={context}
              depth={depth + 1}
              onAdd={(type, settings) => {
                setFirstStep({ type, settings });
                return true;
              }}
            />
          ) : (
            <Button type="button" variant="outline" onClick={() => setFirstStep(undefined)}>
              Change {types.find((entry) => entry.type === firstStep.type)?.title ?? firstStep.type}
            </Button>
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
          <Label htmlFor={`${id}-message`}>Message</Label>
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
          (needsCondition && formula === undefined) ||
          (grouped && firstStep === undefined) ||
          (needsExpression && expression === undefined) ||
          (chosen?.type === "switch" && caseValue === null) ||
          (chosen?.type === "for_each" &&
            (!Number.isSafeInteger(maximumItems) ||
              maximumItems < 1 ||
              maximumItems > flowMaximumForEachItemsOther)) ||
          (chosen?.type === "run_flow" &&
            (selectedFlow === undefined ||
              requiredInputs.some(([name]) => inputs[name] === undefined)))
        }
        onClick={() => {
          if (chosen !== null) {
            const added = onAdd(chosen.type, {
              ...(choices.length > 0 ? { choices: picks } : {}),
              ...(needsMessage ? { message: message.trim() } : {}),
              ...(needsField ? { field } : {}),
              ...(needsCondition && formula !== undefined ? { condition: formula } : {}),
              ...(grouped && firstStep !== undefined ? { firstStep } : {}),
              ...(needsExpression && expression !== undefined ? { value: expression } : {}),
              ...(chosen.type === "switch" && caseValue !== null ? { caseValue } : {}),
              ...(chosen.type === "for_each" ? { maximumItems } : {}),
              ...(chosen.type === "run_flow" ? { flowId: target, inputs } : {}),
            });
            if (!added) return;
            setPicks({});
            setMessage("");
            setField("");
            setCondition(undefined);
            setFormula(undefined);
            setExpression(undefined);
            setExpressionType(undefined);
            setCaseValue(null);
            setMaximumItems(flowMaximumForEachItemsOther);
            setTarget("");
            setInputs({});
            setFirstStep(undefined);
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
