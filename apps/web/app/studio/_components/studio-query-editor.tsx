"use client";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  changeInlineQuery, createInlineQuery, defaultQueryPageSize, deleteInlineQuery, deriveQueryKey, deriveQueryTotalAlias,
  inlineQueryRecordType, maximumQueryPageSize, queryGroupFieldTypes, queryTotalAccepts, queryTotalOperationLabels,
  type ApplicationSourceDocument, type ConditionNode, type InlineQuery, type InlineQueryAggregate, type InlineQueryInput,
  type InlineQuerySort, type InlineRecordTypeReference,
} from "@vortex/platform/schema";
import { StudioConditionControls, StudioOptionControl, validateStudioCondition } from "@vortex/ui/studio";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { Textarea } from "@vortex/ui/components/textarea";
import { Icon } from "@vortex/ui";
import { StudioField } from "./studio-field";
import { StudioReferencesAlert } from "./studio-references-alert";
import { readStudioQueryFilter, studioQueryFilterContext, writeStudioQueryFilter } from "../_lib/studio-query-filter";
import type { StudioCompiledFields } from "../_lib/studio-data-model";

type Source = ApplicationSourceDocument;
type Operation = InlineQueryAggregate["operation"];
type InputType = InlineQueryInput["type"];

/** The input types a query offers, with the words the editor uses for them. */
const inputTypes: readonly Readonly<{ value: InputType; label: string }>[] = [
  { value: "text", label: "Text" }, { value: "number", label: "Number" }, { value: "decimal_number", label: "Decimal number" },
  { value: "money", label: "Amount of money" },
  { value: "boolean", label: "Yes or no" }, { value: "date", label: "Date" }, { value: "date_time", label: "Date and time" },
  { value: "record_reference", label: "A record" }, { value: "organization_account_reference", label: "A person's account" },
];
const directions = [{ value: "ascending", label: "A to Z, low to high, old to new" }, { value: "descending", label: "Z to A, high to low, new to old" }];

type Form = Readonly<{
  label: string; description: string; select: readonly string[]; sort: readonly InlineQuerySort[];
  group_by: readonly string[]; aggregates: readonly InlineQueryAggregate[]; pageSize: string; inputs: readonly InlineQueryInput[];
}>;
/** The filter as the condition controls left it; null while it is unchanged. */
type FilterEdit = Readonly<{ condition: ConditionNode | undefined; valid: boolean }> | null;

const formOf = (query: InlineQuery): Form => ({
  label: query.label ?? "", description: query.description ?? "", select: query.select, sort: query.sort,
  group_by: query.group_by, aggregates: query.aggregates, pageSize: String(query.page_size), inputs: query.inputs,
});

/** The input keys a filter compares a field with. */
const filterParameters = (filter: unknown): Set<string> => {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "value") continue;
      if (key === "parameter" && typeof child === "string") found.add(child);
      else visit(child);
    }
  };
  visit(filter);
  return found;
};

const moved = <T,>(items: readonly T[], index: number, by: -1 | 1): T[] => {
  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(index + by, 0, item!);
  return next;
};

/** One entry of an ordered list: its controls, then earlier, later and remove. */
function Entry({ label, index, count, disabled, onMove, onRemove, children }: Readonly<{
  label: string; index: number; count: number; disabled: boolean;
  onMove: (by: -1 | 1) => void; onRemove: () => void; children: ReactNode;
}>) {
  return <li className="flex flex-wrap items-center gap-1 rounded-md border border-border p-2">
    <div className="min-w-0 flex-1 space-y-1">{children}</div>
    <Button type="button" size="icon-xs" variant="ghost" aria-label={`Move ${label} earlier`} disabled={disabled || index === 0}
      onClick={() => onMove(-1)}><Icon name="chevron-up" /></Button>
    <Button type="button" size="icon-xs" variant="ghost" aria-label={`Move ${label} later`} disabled={disabled || index === count - 1}
      onClick={() => onMove(1)}><Icon name="chevron-down" /></Button>
    <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove ${label}`} disabled={disabled} onClick={onRemove}>
      <Icon name="close" /></Button>
  </li>;
}

/** A label read by screen readers only, for a control whose visible text already says what it does. */
const ScreenReaderLabel = ({ id, children }: Readonly<{ id: string; children: string }>) =>
  <Label htmlFor={id} className="sr-only">{children}</Label>;

function Section({ title, hint, children }: Readonly<{ title: string; hint?: string; children: ReactNode }>) {
  return <fieldset className="space-y-2 border-t border-border pt-3">
    <legend className="text-sm font-semibold">{title}</legend>
    {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
    {children}
  </fieldset>;
}

/**
 * The query editor of the Data tab: a query of a module this application owns, with its name, the
 * columns it returns and their order, its filter (built with the typed condition controls, against
 * fixed values or the query's inputs), its sorting, grouping and totals, its page size and its
 * inputs. Each Apply is one edit of the application draft. Delete is refused while anything uses it.
 */
export function StudioQueryEditor({ source, moduleKey, queryKey, compiledFields, recordTypes, disabled, onPendingChange,
  onApply, onDeleted, onShow }: Readonly<{
  source: Source; moduleKey: string; queryKey: string;
  /** The compiled fields of the saved draft, which the filter's typed controls need. */
  compiledFields: StudioCompiledFields | null;
  /** Every record type of the application, which a record input may name. */
  recordTypes: readonly Readonly<{ key: string; label: string }>[];
  disabled: boolean;
  onPendingChange: (pending: boolean) => void;
  /** Applies the changed source to the draft history; false when the draft moved on meanwhile. */
  onApply: (expected: Source, next: Source, message: string) => boolean;
  onDeleted: (recordKey: string | undefined) => void;
  onShow: (reference: InlineRecordTypeReference) => void;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  const module = source.body.modules.find((item) => item.key === moduleKey);
  const query = module?.queries.find((item) => item.key === queryKey);
  const record = module === undefined || query === undefined ? undefined : inlineQueryRecordType(module, query);
  const initial = useMemo(() => query === undefined ? undefined : formOf(query), [query]);
  const [form, setForm] = useState<Form | undefined>(initial);
  const [filterEdit, setFilterEdit] = useState<FilterEdit>(null);
  const [filterEpoch, setFilterEpoch] = useState(0);
  const [newInput, setNewInput] = useState<Readonly<{ label: string; type: InputType }>>({ label: "", type: "text" });
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [message, setMessage] = useState("");
  const [references, setReferences] = useState<readonly InlineRecordTypeReference[]>([]);
  const [refusals, setRefusals] = useState(0);
  const pending = filterEdit !== null || JSON.stringify(form) !== JSON.stringify(initial);
  useEffect(() => { onPendingChange(pending); }, [pending, onPendingChange]);
  useEffect(() => () => onPendingChange(false), [onPendingChange]);

  const recordReference = query === undefined ? "" : query.record_type.includes(":") ? query.record_type : `${moduleKey}:${query.record_type}`;
  const compiled = compiledFields?.recordTypes[recordReference];
  const filterable = useMemo(() => new Set((record?.fields ?? []).filter((field) => field.filterable).map((field) => field.key)), [record]);
  const context = useMemo(() => compiled === undefined || form === undefined ? undefined
    : studioQueryFilterContext(compiled, filterable, form.inputs), [compiled, filterable, form]);
  const reading = useMemo(() => query === undefined ? undefined : compiled === undefined
    ? { kind: "unreadable" as const, reason: "Save the draft to edit the filter: its controls work on the saved fields." }
    : readStudioQueryFilter(query.filter, (key) => compiled.find((field) => field.key === key)?.fieldId), [query, compiled]);

  if (module === undefined || query === undefined || form === undefined || initial === undefined)
    return <p role="status" className="text-sm">This query is not in the draft any more. Choose another item in the Data panel.</p>;
  if (record === undefined)
    return <p role="note" className="text-sm">This query lists records of another module&apos;s record type, so Studio does not edit it here.</p>;

  const fields = record.fields;
  const labelOf = (key: string) => fields.find((field) => field.key === key)?.label ?? key;
  const change = (next: Partial<Form>) => { setForm({ ...form, ...next }); setIssues([]); setMessage(""); };
  const fieldOptions = (keys: readonly string[]) => keys.map((key) => ({ value: key, label: labelOf(key) }));
  const unselected = fields.filter((field) => !form.select.includes(field.key)).map((field) => field.key);
  const sortable = (form.group_by.length > 0 ? form.group_by : fields.filter((field) => field.sortable).map((field) => field.key));
  const groupable = fields.filter((field) => queryGroupFieldTypes.has(field.type) && !form.group_by.includes(field.key)).map((field) => field.key);
  const takenColumns = () => new Set([...form.select, ...form.aggregates.map((total) => total.alias)]);
  const totalFields = (operation: Operation) => fields.filter((field) => queryTotalAccepts(operation, field.type)).map((field) => field.key);
  const choiceHints = fields.filter((field) => filterable.has(field.key) && (field.type === "choice" || field.type === "several_choices"))
    .map((field) => `${field.label}: ${((field.settings as { options?: { value: string; label: string }[] }).options ?? [])
      .map((option) => `${option.value} (${option.label})`).join(", ")}`);

  const filterValue = filterEdit === null ? reading?.kind === "read" ? reading.condition : undefined : filterEdit.condition;
  const retainedFilterProblems = (): string[] => {
    if (reading?.kind === "read" && reading.condition !== undefined && context !== undefined) {
      const validation = validateStudioCondition(reading.condition, context);
      return validation.isValid ? []
        : validation.issues.map((issue) => `Filter${issue.pointer === "" ? "" : ` (${issue.pointer})`}: ${issue.message}.`);
    }
    // Without the saved fields the filter can't be read here, so a changed input it uses is refused.
    const before = new Map(query.inputs.map((input) => [input.key, input.type] as const));
    return [...filterParameters(query.filter)].flatMap((key) => {
      const now = form.inputs.find((input) => input.key === key);
      return now !== undefined && before.get(key) !== undefined && before.get(key) !== now.type
        ? [`Filter: it compares a field with the input ${now.label}, whose type changed. Save the draft to edit the filter, or put the type back.`]
        : [];
    });
  };
  const reset = () => { setForm(initial); setFilterEdit(null); setFilterEpoch((value) => value + 1); setIssues([]); setMessage(""); };
  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || !pending) return;
    const pageSize = Number(form.pageSize);
    if (filterEdit !== null && !filterEdit.valid) {
      setIssues(["Filter: correct the comparisons marked above first."]);
      return;
    }
    const filter = filterEdit === null ? query.filter
      : writeStudioQueryFilter(filterEdit.condition, (fieldId) => compiled?.find((field) => field.fieldId === fieldId)?.key);
    if (filter === undefined) { setIssues(["Filter: it names a field that is not in this record type any more."]); return; }
    // A filter kept as it was is checked again against the inputs as they are now: an input whose
    // type changed can leave a comparison with it that no longer fits.
    const retained = filterEdit === null && query.filter !== null ? retainedFilterProblems() : [];
    if (retained.length > 0) {
      setIssues(retained);
      setMessage("The query was not changed. Your entries are kept; change the filter or the input, or clear the filter.");
      return;
    }
    const result = changeInlineQuery(source, moduleKey, queryKey, {
      label: form.label, description: form.description, select: [...form.select], sort: [...form.sort],
      group_by: [...form.group_by], aggregates: [...form.aggregates], inputs: [...form.inputs], filter,
      page_size: Number.isInteger(pageSize) ? pageSize : Number.NaN,
    });
    if (result.kind === "invalid") {
      setIssues(result.issues);
      setMessage("The query was not changed. Your entries are kept; correct them using the reasons below.");
      return;
    }
    if (!onApply(source, result.source, "Query changed. Save to keep it.")) {
      setMessage("The draft changed or is busy, so the query was not changed. Try again in a moment.");
      return;
    }
    setFilterEdit(null);
  };
  const remove = async () => {
    setIssues([]);
    const result = deleteInlineQuery(source, moduleKey, queryKey);
    if (result.kind === "referenced") { setReferences(result.references); setRefusals((value) => value + 1); return; }
    if (result.kind === "invalid") { setIssues(result.issues); return; }
    if (!await confirm({
      title: `Delete ${form.label || queryKey}?`,
      description: "The query leaves the draft. Nothing uses it, so no page, menu or flow changes.",
      confirmLabel: "Delete query",
    })) return;
    if (!onApply(source, result.source, "Query deleted from the draft. Save to keep it."))
      setMessage("The draft changed or is busy, so nothing was deleted. Try again in a moment.");
    else onDeleted(record.key);
  };
  const addInput = () => {
    const label = newInput.label.trim();
    const key = deriveQueryKey(label, new Set(form.inputs.map((input) => input.key)));
    if (label === "" || key === undefined) { setIssues(["Inputs: enter the input's name, for example Company."]); return; }
    const recordType = recordTypes[0]?.key;
    if (newInput.type === "record_reference" && recordType === undefined) { setIssues(["Inputs: this application has no record type to choose."]); return; }
    const input = { key, label: label.slice(0, 60), required: true, type: newInput.type,
      ...(newInput.type === "record_reference" ? { record_types: [recordType] } : {}) } as InlineQueryInput;
    change({ inputs: [...form.inputs, input] });
    setNewInput({ label: "", type: "text" });
  };
  const setInput = (index: number, next: Partial<Record<string, unknown>>) =>
    change({ inputs: form.inputs.map((input, at) => at === index ? { ...input, ...next } as InlineQueryInput : input) });

  return <form className="space-y-4" onSubmit={apply} aria-label={`Query ${query.label ?? query.key}`}>
    <StudioField label="Name" hint={`Key: ${query.key}. It does not change when the name does. Lists ${record.plural_name}.`}>
      {(control) => <Input {...control} value={form.label} maxLength={60} disabled={disabled}
        onChange={(event) => change({ label: event.target.value })} />}
    </StudioField>
    <StudioField label="Description" hint="What the query lists, for other builders. Optional.">
      {(control) => <Textarea {...control} value={form.description} maxLength={1_000} disabled={disabled}
        onChange={(event) => change({ description: event.target.value })} />}
    </StudioField>

    <Section title="Columns" hint="The fields the query returns, in the order lists show them.">
      <ol className="list-none space-y-1" aria-label="Columns">{form.select.map((key, index) =>
        <Entry key={key} label={labelOf(key)} index={index} count={form.select.length} disabled={disabled}
          onMove={(by) => change({ select: moved(form.select, index, by) })}
          onRemove={() => change({ select: form.select.filter((item) => item !== key) })}>
          <span className="text-sm">{labelOf(key)}</span>
        </Entry>)}</ol>
      {unselected.length === 0 ? <p className="text-xs text-muted-foreground">Every field is a column.</p>
        : <><ScreenReaderLabel id={`query-${queryKey}-add-column`}>Add a column</ScreenReaderLabel>
          <StudioOptionControl id={`query-${queryKey}-add-column`} value="" unset="Add a column…" disabled={disabled}
          options={fieldOptions(unselected)} onChange={(key) => { if (key !== "") change({ select: [...form.select, key] }); }} /></>}
    </Section>

    <Section title="Filter" hint="Which records the query lists. Compare a field with a fixed value or with one of the query's inputs.">
      {reading?.kind === "unreadable" || context === undefined
        ? <p role="note" className="text-sm">{reading?.kind === "unreadable" ? reading.reason : "The filter can't be edited here."} The filter stays as it is.</p>
        : <StudioConditionControls key={filterEpoch} label="Filter" context={context}
          {...(filterValue === undefined ? {} : { value: filterValue })}
          onChange={(condition, validation) => { setFilterEdit({ condition, valid: validation.isValid }); setIssues([]); setMessage(""); }} />}
      {choiceHints.length === 0 ? null : <div className="text-xs text-muted-foreground">
        <p>Choice fields compare by their stored value:</p>
        <ul className="list-disc pl-5">{choiceHints.map((hint) => <li key={hint} className="break-words">{hint}</li>)}</ul>
      </div>}
    </Section>

    <Section title="Sorting" hint={form.group_by.length > 0 ? "A grouped query sorts by its groups." : "The order records are listed in. Only sortable fields are offered."}>
      <ol className="list-none space-y-1" aria-label="Sorting">{form.sort.map((sort, index) =>
        <Entry key={`${sort.field}:${index}`} label={labelOf(sort.field)} index={index} count={form.sort.length} disabled={disabled}
          onMove={(by) => change({ sort: moved(form.sort, index, by) })}
          onRemove={() => change({ sort: form.sort.filter((_, at) => at !== index) })}>
          <Label className="text-xs" htmlFor={`query-${queryKey}-sort-${index}`}>Sort by {labelOf(sort.field)}</Label>
          <StudioOptionControl id={`query-${queryKey}-sort-${index}`} value={sort.direction} disabled={disabled} options={directions}
            onChange={(direction) => change({ sort: form.sort.map((item, at) => at === index ? { ...item, direction: direction as InlineQuerySort["direction"] } : item) })} />
        </Entry>)}</ol>
      {sortable.filter((key) => !form.sort.some((sort) => sort.field === key)).length === 0 ? null
        : <><ScreenReaderLabel id={`query-${queryKey}-add-sort`}>Add a sort</ScreenReaderLabel>
          <StudioOptionControl id={`query-${queryKey}-add-sort`} value="" unset="Add a sort…" disabled={disabled}
          options={fieldOptions(sortable.filter((key) => !form.sort.some((sort) => sort.field === key)))}
          onChange={(key) => { if (key !== "") change({ sort: [...form.sort, { field: key, direction: "ascending" }] }); }} /></>}
    </Section>

    <Section title="Grouping and totals" hint="Groups and totals make the query a summary: it then feeds Summary values, Charts and Boards. A Records table lists a query without them.">
      <ol className="list-none space-y-1" aria-label="Groups">{form.group_by.map((key, index) =>
        <Entry key={key} label={`group ${labelOf(key)}`} index={index} count={form.group_by.length} disabled={disabled}
          onMove={(by) => change({ group_by: moved(form.group_by, index, by) })}
          onRemove={() => change({ group_by: form.group_by.filter((item) => item !== key), sort: form.sort.filter((sort) => sort.field !== key) })}>
          <span className="text-sm">Group by {labelOf(key)}</span>
        </Entry>)}</ol>
      {groupable.length === 0 ? null : <><ScreenReaderLabel id={`query-${queryKey}-add-group`}>Group by</ScreenReaderLabel>
        <StudioOptionControl id={`query-${queryKey}-add-group`} value="" unset="Group by…" disabled={disabled}
        options={fieldOptions(groupable)} onChange={(key) => {
          if (key === "") return;
          const group_by = [...form.group_by, key];
          // A grouped query sorts by its groups only.
          const kept = form.sort.filter((sort) => group_by.includes(sort.field));
          change({ group_by, sort: kept.length > 0 ? kept : [{ field: key, direction: "ascending" }] });
        }} /></>}
      <ol className="list-none space-y-1" aria-label="Totals">{form.aggregates.map((total, index) =>
        <Entry key={total.alias} label={`total ${index + 1}`} index={index} count={form.aggregates.length} disabled={disabled}
          onMove={(by) => change({ aggregates: moved(form.aggregates, index, by) })}
          onRemove={() => change({ aggregates: form.aggregates.filter((_, at) => at !== index) })}>
          <Label className="text-xs" htmlFor={`query-${queryKey}-total-${index}`}>Total {index + 1}</Label>
          <StudioOptionControl id={`query-${queryKey}-total-${index}`} value={total.operation} disabled={disabled}
            options={(Object.keys(queryTotalOperationLabels) as Operation[]).map((operation) => ({ value: operation, label: queryTotalOperationLabels[operation] }))}
            onChange={(next) => {
              const operation = next as Operation;
              const field = operation === "count" ? undefined
                : total.field !== undefined && totalFields(operation).includes(total.field) ? total.field : totalFields(operation)[0];
              const others = new Set([...form.select, ...form.aggregates.filter((_, at) => at !== index).map((item) => item.alias)]);
              const replaced = { operation, ...(field === undefined ? {} : { field }), alias: deriveQueryTotalAlias(operation, field, others) };
              change({ aggregates: form.aggregates.map((item, at) => at === index ? replaced as InlineQueryAggregate : item) });
            }} />
          {total.operation === "count" ? null : <><ScreenReaderLabel id={`query-${queryKey}-total-${index}-field`}>{`Field of total ${index + 1}`}</ScreenReaderLabel>
            <StudioOptionControl id={`query-${queryKey}-total-${index}-field`} value={total.field ?? ""}
            unset="Choose a field…" disabled={disabled} options={fieldOptions(totalFields(total.operation))}
            onChange={(field) => {
              const others = new Set([...form.select, ...form.aggregates.filter((_, at) => at !== index).map((item) => item.alias)]);
              change({ aggregates: form.aggregates.map((item, at) => at === index
                ? { ...item, ...(field === "" ? {} : { field }), alias: deriveQueryTotalAlias(item.operation, field === "" ? undefined : field, others) } : item) });
            }} /></>}
        </Entry>)}</ol>
      <Button type="button" size="sm" variant="outline" disabled={disabled || form.aggregates.length >= 20}
        onClick={() => change({ aggregates: [...form.aggregates, { operation: "count", alias: deriveQueryTotalAlias("count", undefined, takenColumns()) }] })}>
        <Icon name="plus" />Add a total</Button>
    </Section>

    <Section title="Page size" hint={`Records per page: ${defaultQueryPageSize} unless you choose otherwise, at most ${maximumQueryPageSize}.`}>
      <Input aria-label="Records per page" type="number" inputMode="numeric" min={1} max={maximumQueryPageSize} step={1}
        value={form.pageSize} disabled={disabled} onChange={(event) => change({ pageSize: event.target.value })} />
    </Section>

    <Section title="Inputs" hint="Values a page gives the query when it lists records, for example the company a record page shows. The filter can compare a field with them.">
      <ul className="list-none space-y-1" aria-label="Inputs">{form.inputs.map((input, index) =>
        <li key={input.key} className="space-y-1 rounded-md border border-border p-2">
          <div className="flex items-center gap-1">
            <Input aria-label={`Name of input ${input.key}`} value={input.label} maxLength={60} disabled={disabled}
              onChange={(event) => setInput(index, { label: event.target.value })} />
            <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove input ${input.label}`} disabled={disabled}
              onClick={() => change({ inputs: form.inputs.filter((_, at) => at !== index) })}><Icon name="close" /></Button>
          </div>
          <p className="text-xs text-muted-foreground">Key: {input.key}</p>
          <ScreenReaderLabel id={`query-${queryKey}-input-${index}-type`}>{`Type of input ${input.label}`}</ScreenReaderLabel>
          <StudioOptionControl id={`query-${queryKey}-input-${index}-type`} value={input.type} disabled={disabled} options={inputTypes}
            onChange={(type) => {
              // A new type starts without the old type's record types and validation.
              const base = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "record_types" && key !== "validation"));
              change({ inputs: form.inputs.map((item, at) => at !== index ? item : { ...base, type,
                ...(type === "record_reference" ? { record_types: [recordTypes[0]?.key ?? ""] } : {}) } as InlineQueryInput) });
            }} />
          {input.type === "record_reference" && <><ScreenReaderLabel id={`query-${queryKey}-input-${index}-record`}>{`Record type of input ${input.label}`}</ScreenReaderLabel>
            <StudioOptionControl id={`query-${queryKey}-input-${index}-record`}
            value={(input as { record_types: string[] }).record_types[0] ?? ""} disabled={disabled} options={recordTypes.map((item) => ({ value: item.key, label: item.label }))}
            onChange={(recordType) => setInput(index, { record_types: [recordType] })} /></>}
          <div className="flex items-center gap-2">
            <Checkbox id={`query-${queryKey}-input-${index}-required`} checked={input.required} disabled={disabled}
              onCheckedChange={(checked) => setInput(index, { required: checked === true })} />
            <Label htmlFor={`query-${queryKey}-input-${index}-required`} className="font-normal">The query needs it</Label>
          </div>
        </li>)}</ul>
      <div className="flex flex-wrap items-end gap-2">
        <Input aria-label="Name of a new input" placeholder="New input, for example Company" value={newInput.label} maxLength={60}
          disabled={disabled} className="min-w-0 flex-1" onChange={(event) => setNewInput({ ...newInput, label: event.target.value })} />
        <ScreenReaderLabel id={`query-${queryKey}-new-input-type`}>Type of the new input</ScreenReaderLabel>
        <StudioOptionControl id={`query-${queryKey}-new-input-type`} value={newInput.type} disabled={disabled} options={inputTypes}
          onChange={(type) => setNewInput({ ...newInput, type: type as InputType })} />
        <Button type="button" size="sm" variant="outline" disabled={disabled || newInput.label.trim() === ""} onClick={addInput}>Add input</Button>
      </div>
    </Section>

    <div className="flex flex-wrap gap-2">
      <Button type="submit" size="sm" disabled={disabled || !pending}>Apply</Button>
      <Button type="button" size="sm" variant="outline" disabled={disabled || !pending} onClick={reset}>Discard</Button>
    </div>
    <p role="status" aria-live="polite" className="text-sm">{message}</p>
    {issues.length === 0 ? null : <ul className="space-y-1 text-sm text-destructive" aria-label="Why the query was not changed" role="alert">
      {issues.map((issue, index) => <li key={index} className="break-words">{issue}</li>)}
    </ul>}
    <section className="space-y-2 border-t border-border pt-3" aria-label="Delete">
      <Button type="button" size="sm" variant="destructive" disabled={disabled || pending} onClick={() => { void remove(); }}>Delete query</Button>
      <StudioReferencesAlert key={refusals} name={form.label || query.key} action="deleted" references={references} onShow={onShow} />
    </section>
    {confirmDialog}
  </form>;
}

/** Names a new query of a record type; the query starts as a plain list of it. */
export function StudioNewQueryForm({ source, moduleKey, recordKey, disabled, onApply, onCreated }: Readonly<{
  source: Source; moduleKey: string; recordKey: string; disabled: boolean;
  onApply: (expected: Source, next: Source, message: string) => boolean;
  onCreated: (queryKey: string) => void;
}>) {
  const module = source.body.modules.find((item) => item.key === moduleKey);
  const [label, setLabel] = useState("");
  const [issues, setIssues] = useState<readonly string[]>([]);
  const key = deriveQueryKey(label, new Set(module?.queries.map((query) => query.key) ?? []));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = createInlineQuery(source, { moduleKey, recordKey, label, key: key ?? "" });
    if (result.kind === "invalid") { setIssues(result.issues); return; }
    if (!onApply(source, result.source, "Query added. Save to keep it.")) {
      setIssues(["The draft changed or is busy, so the query was not added. Try again in a moment."]);
      return;
    }
    onCreated(result.queryKey);
  };
  return <form className="space-y-2" onSubmit={submit} aria-label="New query">
    <StudioField label="Query name" hint={key === undefined ? "For example Open companies. A key is made from it."
      : `Its key will be "${key}". It does not change later.`}>
      {(control) => <Input {...control} value={label} maxLength={60} disabled={disabled}
        onChange={(event) => { setLabel(event.target.value); setIssues([]); }} />}
    </StudioField>
    <Button type="submit" size="sm" disabled={disabled || label.trim() === ""}>Add query</Button>
    {issues.length === 0 ? null : <ul role="alert" className="space-y-1 text-sm text-destructive">
      {issues.map((issue, index) => <li key={index} className="break-words">{issue}</li>)}</ul>}
  </form>;
}
