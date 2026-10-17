"use client";
import { useMemo } from "react";
import {
  calculationNumberOperationLabels, calculationOperationLabels, calculationResultChoices, calculationResultTypeLabels,
  dateAccepts, describeCalculation, joinTextAccepts, numberAccepts, starterCalculationExpression, wholeNumberAccepts,
  type CalculationExpression, type CalculationNumber, type CalculationNumberOperation, type CalculationOperation,
  type CalculationSettings, type FormulaField, type ModuleField,
} from "@vortex/platform/schema";
import { StudioOptionControl } from "@vortex/ui/studio";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { StudioField } from "./studio-field";
import { StudioFormulaCondition } from "./studio-formula-condition";

type Numeric = Extract<CalculationNumber, { source: "numeric" }>;
type Expression<K extends CalculationOperation> = Extract<CalculationExpression, { operation: K }>;

const operationOptions = (Object.keys(calculationOperationLabels) as CalculationOperation[])
  .map((value) => ({ value, label: calculationOperationLabels[value] }));
const numberOperationOptions = (Object.keys(calculationNumberOperationLabels) as CalculationNumberOperation[])
  .map((value) => ({ value, label: calculationNumberOperationLabels[value] }));
const units = [{ value: "days", label: "Days" }, { value: "weeks", label: "Weeks" }, { value: "months", label: "Months" }, { value: "years", label: "Years" }];
const sources = [{ value: "field", label: "A field" }, { value: "literal", label: "A fixed number" }, { value: "numeric", label: "A part in brackets" }];

/**
 * A calculation's settings with its result kept to what its formula can give: the result type is
 * offered only among those, decimal places are kept exactly when the result needs them, and when
 * it is worked out is always written down.
 */
const settled = (settings: CalculationSettings, fields: ReadonlyMap<string, FormulaField>): CalculationSettings => {
  const choices = calculationResultChoices(settings.expression, fields);
  const result_type = choices.length === 0 || choices.includes(settings.result_type) ? settings.result_type : choices[0]!;
  const precise = result_type === "decimal_number" || result_type === "money";
  const { decimal_places: places, evaluation, ...rest } = settings;
  return {
    ...rest, result_type,
    // A deadline uses the current time, so it is read-time; any other formula keeps the choice made, saved by default.
    evaluation: settings.expression.operation === "deadline_passed" ? "read_time" : evaluation ?? "stored",
    ...(precise ? { decimal_places: places ?? 2 } : {}),
  } as CalculationSettings;
};

/** One value of a number in the formula: a field, a fixed number, or a part in brackets with its own values. */
function NumberValue({ id, value, fields, depth, disabled, onChange, onRemove }: Readonly<{
  id: string; value: CalculationNumber; fields: readonly FormulaField[]; depth: number; disabled: boolean;
  onChange: (value: CalculationNumber) => void; onRemove: (() => void) | undefined;
}>) {
  const numeric = fields.filter(numberAccepts).map((field) => ({ value: field.key, label: field.label }));
  const changeSource = (source: string) => {
    if (source === value.source) return;
    if (source === "field") onChange({ source: "field", field: numeric[0]?.value ?? "" });
    else if (source === "literal") onChange({ source: "literal", value: "1" });
    else onChange({ source: "numeric", numeric_operation: "add", operands: [value.source === "numeric" ? { source: "literal", value: "1" } : value, { source: "literal", value: "1" }] });
  };
  return <li className="space-y-1 rounded-md border border-border p-2">
    <div className="flex flex-wrap items-center gap-1">
      <div className="min-w-0 flex-1">
        <Label className="sr-only" htmlFor={`${id}-source`}>Value comes from</Label>
        <StudioOptionControl id={`${id}-source`} value={value.source} disabled={disabled}
          options={depth >= 8 ? sources.slice(0, 2) : sources} onChange={changeSource} />
      </div>
      {onRemove === undefined ? null : <Button type="button" size="icon-xs" variant="ghost" aria-label="Remove this value"
        disabled={disabled} onClick={onRemove}><Icon name="close" /></Button>}
    </div>
    {value.source === "field"
      ? <><Label className="sr-only" htmlFor={`${id}-field`}>Field</Label>
        <StudioOptionControl id={`${id}-field`} value={value.field} unset="Choose a field…" disabled={disabled} options={numeric}
          onChange={(field) => onChange({ source: "field", field })} /></>
      : value.source === "literal"
        ? <><Label className="sr-only" htmlFor={`${id}-literal`}>Fixed number</Label>
          <Input id={`${id}-literal`} inputMode="decimal" maxLength={60} value={value.value} disabled={disabled}
            onChange={(event) => onChange({ source: "literal", value: event.target.value.trim() })} /></>
        : <NumberPart id={id} part={value} fields={fields} depth={depth + 1} disabled={disabled} onChange={onChange} />}
  </li>;
}

/** A part of the formula: an operation over two or more values, worked out left to right. */
function NumberPart({ id, part, fields, depth, disabled, onChange }: Readonly<{
  id: string; part: Numeric; fields: readonly FormulaField[]; depth: number; disabled: boolean;
  onChange: (part: Numeric) => void;
}>) {
  const setOperand = (index: number, next: CalculationNumber) =>
    onChange({ ...part, operands: part.operands.map((operand, at) => at === index ? next : operand) });
  return <div className="space-y-1 border-l-2 border-border pl-2">
    <Label className="text-xs" htmlFor={`${id}-operation`}>Operation</Label>
    <StudioOptionControl id={`${id}-operation`} value={part.numeric_operation} disabled={disabled} options={numberOperationOptions}
      onChange={(operation) => onChange({ ...part, numeric_operation: operation as CalculationNumberOperation })} />
    <ol className="list-none space-y-1" aria-label="Values, worked out in this order">
      {part.operands.map((operand, index) => <NumberValue key={index} id={`${id}-${index}`} value={operand} fields={fields} depth={depth}
        disabled={disabled} onChange={(next) => setOperand(index, next)}
        onRemove={part.operands.length <= 2 ? undefined : () => onChange({ ...part, operands: part.operands.filter((_, at) => at !== index) })} />)}
    </ol>
    <Button type="button" size="sm" variant="outline" disabled={disabled || part.operands.length >= 20}
      onClick={() => onChange({ ...part, operands: [...part.operands, { source: "literal", value: "1" }] })}>Add a value</Button>
  </div>;
}

/**
 * The formula editor of a calculation field: what it works out (joined text, a number from
 * fields and fixed numbers with parts in brackets, a yes-or-no condition, a moved date, or whether
 * a deadline has passed), its result, and when it is worked out. The formula reads back as one line.
 */
export function StudioCalculationEditor({ idPrefix, settings, fields, compiled, disabled, onChange }: Readonly<{
  idPrefix: string;
  settings: CalculationSettings;
  /** The other fields of the record type, which the formula can name. */
  fields: readonly FormulaField[];
  /** The saved draft's compiled fields of the record type, which a condition's controls need. */
  compiled: readonly ModuleField[] | undefined;
  disabled: boolean;
  /** The changed settings, and whether a condition in them is complete. */
  onChange: (settings: CalculationSettings, conditionValid: boolean) => void;
}>) {
  const byKey = useMemo(() => new Map(fields.map((field) => [field.key, field])), [fields]);
  const conditionKeys = useMemo(() => new Set(fields.map((field) => field.key)), [fields]);
  const labelOf = (key: string) => byKey.get(key)?.label ?? key;
  const expression = settings.expression;
  const set = (next: Partial<CalculationSettings>, conditionValid = true) => onChange(settled({ ...settings, ...next } as CalculationSettings, byKey), conditionValid);
  const setExpression = (next: CalculationExpression, conditionValid = true) => set({ expression: next }, conditionValid);
  const choicesOf = (accepts: (field: FormulaField) => boolean) => fields.filter(accepts).map((field) => ({ value: field.key, label: field.label }));
  const results = calculationResultChoices(expression, byKey);
  const precise = settings.result_type === "decimal_number" || settings.result_type === "money";
  const id = (part: string) => `${idPrefix}-${part}`;

  const body = (() => {
    switch (expression.operation) {
      case "join_text": {
        const joined = expression as Expression<"join_text">;
        const offered = choicesOf(joinTextAccepts).filter((option) => !joined.fields.includes(option.value));
        return <>
          <ol className="list-none space-y-1" aria-label="Joined fields">{joined.fields.map((key, index) =>
            <li key={key} className="flex items-center gap-1 rounded-md border border-border p-2 text-sm">
              <span className="min-w-0 flex-1">{labelOf(key)}</span>
              <Button type="button" size="icon-xs" variant="ghost" aria-label={`Move ${labelOf(key)} earlier`} disabled={disabled || index === 0}
                onClick={() => { const next = [...joined.fields]; next.splice(index - 1, 0, next.splice(index, 1)[0]!); setExpression({ ...joined, fields: next }); }}>
                <Icon name="chevron-up" /></Button>
              <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove ${labelOf(key)}`} disabled={disabled}
                onClick={() => setExpression({ ...joined, fields: joined.fields.filter((item) => item !== key) })}><Icon name="close" /></Button>
            </li>)}</ol>
          {offered.length === 0 ? null : <StudioOptionControl id={id("join-add")} value="" unset="Add a field…" disabled={disabled || joined.fields.length >= 20}
            options={offered} onChange={(key) => { if (key !== "") setExpression({ ...joined, fields: [...joined.fields, key] }); }} />}
          <StudioField label="Between the values" hint="For example a space, or a comma and a space.">
            {(control) => <Input {...control} maxLength={20} value={joined.separator} disabled={disabled}
              onChange={(event) => setExpression({ ...joined, separator: event.target.value })} />}
          </StudioField>
        </>;
      }
      case "numeric": {
        const root: Numeric = { source: "numeric", numeric_operation: expression.numeric_operation, operands: expression.operands };
        return <NumberPart id={id("number")} part={root} fields={fields} depth={1} disabled={disabled}
          onChange={(part) => setExpression({ operation: "numeric", numeric_operation: part.numeric_operation, operands: part.operands })} />;
      }
      case "condition":
        return <StudioFormulaCondition label="Yes when" condition={(expression as { condition?: unknown }).condition} compiled={compiled}
          fieldKeys={conditionKeys} disabled={disabled}
          onChange={(condition, valid) => setExpression({ operation: "condition", ...(condition === undefined ? {} : { condition }) } as CalculationExpression, valid)} />;
      case "date_offset": {
        const moved = expression as Expression<"date_offset">;
        return <>
          <StudioField label="Date">
            {(control) => <StudioOptionControl id={control.id} value={moved.date_field} unset="Choose a date field…" disabled={disabled}
              options={choicesOf(dateAccepts)} onChange={(date_field) => setExpression({ ...moved, date_field })} />}
          </StudioField>
          <StudioField label="By how much comes from">
            {(control) => <StudioOptionControl id={control.id} value={moved.amount.source} disabled={disabled}
              options={sources.slice(0, 2).map((option) => option.value === "literal" ? { ...option, label: "A fixed whole number" } : option)}
              onChange={(source) => setExpression({ ...moved, amount: source === "field"
                ? { source: "field", field: choicesOf(wholeNumberAccepts)[0]?.value ?? "" } : { source: "literal", value: "7" } })} />}
          </StudioField>
          {moved.amount.source === "field"
            ? <StudioField label="Whole-number field">
              {(control) => <StudioOptionControl id={control.id} value={moved.amount.source === "field" ? moved.amount.field : ""} unset="Choose a field…"
                disabled={disabled} options={choicesOf(wholeNumberAccepts)} onChange={(field) => setExpression({ ...moved, amount: { source: "field", field } })} />}
            </StudioField>
            : <StudioField label="By how much" hint="A whole number; a negative number moves the date earlier.">
              {(control) => <Input {...control} inputMode="numeric" maxLength={20} disabled={disabled}
                value={moved.amount.source === "literal" ? moved.amount.value : ""}
                onChange={(event) => setExpression({ ...moved, amount: { source: "literal", value: event.target.value.trim() } })} />}
            </StudioField>}
          <StudioField label="Unit">
            {(control) => <StudioOptionControl id={control.id} value={moved.unit} disabled={disabled} options={units}
              onChange={(unit) => setExpression({ ...moved, unit: unit as Expression<"date_offset">["unit"] })} />}
          </StudioField>
        </>;
      }
      case "deadline_passed": {
        const deadline = expression as Expression<"deadline_passed">;
        const status = deadline.status_field === undefined ? undefined : byKey.get(deadline.status_field);
        const statusOptions = ((status?.settings as { options?: { value: string; label: string }[] } | undefined)?.options ?? []);
        const finished = new Set(deadline.terminal_status_values.map(String));
        return <>
          <StudioField label="Due">
            {(control) => <StudioOptionControl id={control.id} value={deadline.due_field} unset="Choose a date field…" disabled={disabled}
              options={choicesOf(dateAccepts)} onChange={(due_field) => setExpression({ ...deadline, due_field })} />}
          </StudioField>
          <StudioField label="Status" hint="Optional. A record in a finished status never counts as past its deadline.">
            {(control) => <StudioOptionControl id={control.id} value={deadline.status_field ?? ""} unset="No status" disabled={disabled}
              options={choicesOf(joinTextAccepts)} onChange={(key) => {
                const rest: Partial<Expression<"deadline_passed">> = { ...deadline };
                delete rest.status_field;
                setExpression({ ...rest, ...(key === "" ? {} : { status_field: key }), terminal_status_values: [] } as Expression<"deadline_passed">);
              }} />}
          </StudioField>
          {status === undefined ? null : statusOptions.length > 0
            ? <fieldset className="space-y-1"><legend className="text-sm">Finished statuses</legend>
              {statusOptions.map((option) => <div key={option.value} className="flex items-center gap-2">
                <Checkbox id={id(`finished-${option.value}`)} checked={finished.has(option.value)} disabled={disabled}
                  onCheckedChange={(checked) => setExpression({ ...deadline, terminal_status_values: checked === true
                    ? [...deadline.terminal_status_values, option.value]
                    : deadline.terminal_status_values.filter((value) => value !== option.value) })} />
                <Label htmlFor={id(`finished-${option.value}`)} className="font-normal">{option.label}</Label>
              </div>)}
            </fieldset>
            : <StudioField label="Finished statuses" hint="The status values that end the deadline, separated by commas.">
              {(control) => <Input {...control} maxLength={600} disabled={disabled} value={deadline.terminal_status_values.map(String).join(", ")}
                onChange={(event) => setExpression({ ...deadline, terminal_status_values: event.target.value.split(",").map((value) => value.trim()).filter((value) => value !== "").slice(0, 20) })} />}
            </StudioField>}
        </>;
      }
    }
  })();

  return <div className="space-y-3">
    <StudioField label="What it works out">
      {(control) => <StudioOptionControl id={control.id} value={expression.operation} disabled={disabled} options={operationOptions}
        onChange={(operation) => {
          if (operation === expression.operation) return;
          const next = starterCalculationExpression(operation as CalculationOperation, fields);
          set({ expression: next, result_type: calculationResultChoices(next, byKey)[0] ?? settings.result_type });
        }} />}
    </StudioField>
    <section className="space-y-2" aria-label="Formula">{body}</section>
    <p className="break-words rounded-md bg-muted p-2 text-sm" aria-label="The formula reads">
      <span className="font-medium">{calculationResultTypeLabels[settings.result_type]} =</span> {describeCalculation(expression, labelOf)}
    </p>
    {results.length > 1
      ? <StudioField label="Result">
        {(control) => <StudioOptionControl id={control.id} value={settings.result_type} disabled={disabled}
          options={results.map((value) => ({ value, label: calculationResultTypeLabels[value] }))}
          onChange={(result_type) => set({ result_type: result_type as CalculationSettings["result_type"] })} />}
      </StudioField>
      : <p className="text-sm text-muted-foreground">{results.length === 1 ? `The result is ${calculationResultTypeLabels[results[0]!].toLowerCase()}.`
        : "The result is worked out from the formula once it is complete."}</p>}
    {precise && <StudioField label="Decimal places" hint="How many decimal places the result keeps, from 0 to 12.">
      {(control) => <Input {...control} type="number" min={0} max={12} step={1} disabled={disabled} value={settings.decimal_places ?? ""}
        onChange={(event) => set({ decimal_places: event.target.value === "" ? undefined : Math.trunc(Number(event.target.value)) })} />}
    </StudioField>}
    {expression.operation === "deadline_passed"
      ? <p className="text-sm text-muted-foreground">It depends on the current time, so it is worked out each time it is read.</p>
      : <StudioField label="When it is worked out" hint="A saved result is kept with the record; a read-time result is worked out afresh each time.">
        {(control) => <StudioOptionControl id={control.id} value={settings.evaluation ?? ""} disabled={disabled}
          options={[{ value: "stored", label: "When the record is saved" }, { value: "read_time", label: "Each time it is read" }]}
          onChange={(evaluation) => set({ evaluation: evaluation as "read_time" | "stored" })} />}
      </StudioField>}
  </div>;
}
