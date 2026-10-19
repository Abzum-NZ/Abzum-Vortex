"use client";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  changeInlineQuery,
  createInlineQuery,
  defaultQueryPageSize,
  deleteInlineQuery,
  deriveQueryKey,
  deriveQueryTotalAlias,
  inlineQueryRecordType,
  maximumQueryPageSize,
  queryGroupFieldTypes,
  queryTotalAccepts,
  queryTotalOperationLabels,
  type ApplicationSourceDocument,
  type ConditionNode,
  type InlineQuery,
  type InlineQueryAggregate,
  type InlineQueryInput,
  type InlineQueryChange,
  type InlineQuerySort,
  type ApplicationUsePlace,
} from "@vortex/platform/schema";
import {
  StudioConditionControls,
  StudioOptionControl,
  validateStudioCondition,
} from "@vortex/ui/studio";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { Textarea } from "@vortex/ui/components/textarea";
import { Icon } from "@vortex/ui";
import { StudioDataGroup } from "./studio-data-group";
import { StudioField } from "./studio-field";
import { StudioReferencesAlert } from "./studio-used-in";
import { useStudioDraftText } from "./use-studio-draft-text";
import { useStudioDraftHeld } from "./use-studio-draft-held";
import {
  readStudioQueryFilter,
  studioQueryFilterContext,
  writeStudioQueryFilter,
} from "../_lib/studio-query-filter";
import {
  studioEditProblem,
  type StudioCompiledFields,
  type StudioDataEdit,
} from "../_lib/studio-data-model";

type Source = ApplicationSourceDocument;
type Operation = InlineQueryAggregate["operation"];
type InputType = InlineQueryInput["type"];
/** What one edit of the query changes; the rest stays as the draft holds it. */
type QueryPatch = Partial<InlineQueryChange>;

/** The input types a query offers, with the words the editor uses for them. */
const inputTypes: readonly Readonly<{ value: InputType; label: string }>[] = [
  { value: "text", label: "Text" },
  { value: "whole_number", label: "Whole number" },
  { value: "decimal_number", label: "Decimal number" },
  { value: "money", label: "Amount of money" },
  { value: "yes_no", label: "Yes or no" },
  { value: "date", label: "Date" },
  { value: "date_time", label: "Date and time" },
  { value: "record_reference", label: "A record" },
  { value: "organization_account_reference", label: "A person's account" },
];
/** An input type in the editor's words; a type the editor does not offer is named by its key. */
export const queryInputTypeLabel = (type: string): string =>
  inputTypes.find((option) => option.value === type)?.label ?? type.replaceAll("_", " ");
const directions = [
  { value: "ascending", label: "A to Z, low to high, old to new" },
  { value: "descending", label: "Z to A, high to low, new to old" },
];
const unfinishedFilter =
  "Filter: finish the comparisons marked above. Until then the query keeps its last filter.";

/** The input keys a filter compares a field with. */
const filterParameters = (filter: unknown): Set<string> => {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
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
function Entry({
  label,
  index,
  count,
  disabled,
  onMove,
  onRemove,
  children,
}: Readonly<{
  label: string;
  index: number;
  count: number;
  disabled: boolean;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
  children: ReactNode;
}>) {
  return (
    <li className="flex flex-wrap items-center gap-1 rounded-md border border-border p-2">
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`Move ${label} earlier`}
        disabled={disabled || index === 0}
        onClick={() => onMove(-1)}
      >
        <Icon name="chevron-up" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`Move ${label} later`}
        disabled={disabled || index === count - 1}
        onClick={() => onMove(1)}
      >
        <Icon name="chevron-down" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`Remove ${label}`}
        disabled={disabled}
        onClick={onRemove}
      >
        <Icon name="close" />
      </Button>
    </li>
  );
}

/** A label read by screen readers only, for a control whose visible text already says what it does. */
const ScreenReaderLabel = ({ id, children }: Readonly<{ id: string; children: string }>) => (
  <Label htmlFor={id} className="sr-only">
    {children}
  </Label>
);

function Section({
  title,
  hint,
  children,
}: Readonly<{ title: string; hint?: string; children: ReactNode }>) {
  return (
    <StudioDataGroup title={title}>
      {hint === undefined ? null : <p className="text-sm text-muted-foreground">{hint}</p>}
      {children}
    </StudioDataGroup>
  );
}

/** The name of one query input, applied as it is typed. */
function InputName({
  input,
  disabled,
  commit,
}: Readonly<{
  input: InlineQueryInput;
  disabled: boolean;
  commit: (next: string) => string | true;
}>) {
  const name = useStudioDraftText(input.label, commit);
  return (
    <div className="space-y-1">
      <Input
        aria-label={`Name of input ${input.key}`}
        value={name.text}
        maxLength={60}
        disabled={disabled}
        aria-invalid={name.problem === "" ? undefined : true}
        onChange={(event) => name.change(event.target.value)}
      />
      {name.problem === "" ? null : (
        <p role="alert" className="text-sm text-destructive">
          {name.problem}
        </p>
      )}
    </div>
  );
}

/**
 * The query editor of the Data tab: a query of a module this application owns, with its name, the
 * columns it returns and their order, its filter (built with the typed condition controls, against
 * fixed values or the query's inputs), its sorting, grouping and totals, its page size and its
 * inputs. Each change is one edit of the draft as soon as it is valid; typing is one Undo step. A
 * name, page size or filter that is not valid yet stays in its control with why. Delete is refused
 * while anything uses the query.
 */
export function StudioQueryEditor({
  source,
  moduleKey,
  queryKey,
  compiledFields,
  draftCompiles,
  recordTypes,
  disabled,
  edit,
  onDeleted,
}: Readonly<{
  source: Source;
  moduleKey: string;
  queryKey: string;
  /** The compiled fields of the saved draft, which the filter's typed controls need. */
  compiledFields: StudioCompiledFields | null;
  /** Whether the saved draft compiled: without a compile the filter can only be removed. */
  draftCompiles: boolean;
  /** Every record type of the application, which a record input may name. */
  recordTypes: readonly Readonly<{ key: string; label: string }>[];
  disabled: boolean;
  edit: StudioDataEdit;
  onDeleted: (recordKey: string | undefined) => void;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  const module = source.body.modules.find((item) => item.key === moduleKey);
  const query = module?.queries.find((item) => item.key === queryKey);
  const record =
    module === undefined || query === undefined ? undefined : inlineQueryRecordType(module, query);
  const [newInput, setNewInput] = useState<Readonly<{ label: string; type: InputType }>>({
    label: "",
    type: "text",
  });
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [references, setReferences] = useState<readonly ApplicationUsePlace[]>([]);
  const [refusals, setRefusals] = useState(0);

  const recordReference =
    query === undefined
      ? ""
      : query.record_type.includes(":")
        ? query.record_type
        : `${moduleKey}:${query.record_type}`;
  const compiled = compiledFields?.recordTypes[recordReference];
  const filterable = useMemo(
    () =>
      new Set((record?.fields ?? []).filter((field) => field.filterable).map((field) => field.key)),
    [record],
  );
  const context = useMemo(
    () =>
      compiled === undefined || query === undefined
        ? undefined
        : studioQueryFilterContext(compiled, filterable, query.inputs),
    [compiled, filterable, query],
  );
  const readFilter = (filter: InlineQuery["filter"]) =>
    compiled === undefined
      ? {
          kind: "unreadable" as const,
          reason:
            "The filter can be edited in a moment, once Studio has saved and compiled the draft: its controls work on the compiled fields.",
        }
      : readStudioQueryFilter(
          filter,
          (key) => compiled.find((field) => field.key === key)?.fieldId,
        );
  const reading = query === undefined ? undefined : readFilter(query.filter);
  const filter = useStudioDraftHeld<ConditionNode | undefined>(
    reading?.kind === "read" ? reading.condition : undefined,
  );

  // One edit of the query: the patch over the query as the draft holds it now.
  const run = (patch: QueryPatch, merge?: string) =>
    edit(
      (current) => {
        const now = current.body.modules
          .find((item) => item.key === moduleKey)
          ?.queries.find((item) => item.key === queryKey);
        if (now === undefined)
          return {
            kind: "invalid" as const,
            issues: ["The query is not in this application's modules any more."],
          };
        return changeInlineQuery(current, moduleKey, queryKey, {
          label: now.label ?? "",
          description: now.description ?? "",
          select: now.select,
          sort: now.sort,
          group_by: now.group_by,
          aggregates: now.aggregates,
          inputs: now.inputs,
          filter: now.filter,
          page_size: now.page_size,
          ...patch,
        });
      },
      merge === undefined ? {} : { merge },
    );
  const commit = (patch: QueryPatch, merge?: string): string | undefined =>
    studioEditProblem(run(patch, merge));
  const change = (patch: QueryPatch) => {
    const problem = commit(patch);
    setIssues(problem === undefined ? [] : [problem]);
  };
  const name = useStudioDraftText(
    query?.label ?? "",
    (next) => commit({ label: next }, `query-label:${moduleKey}:${queryKey}`) ?? true,
  );
  const description = useStudioDraftText(
    query?.description ?? "",
    (next) => commit({ description: next }, `query-description:${moduleKey}:${queryKey}`) ?? true,
  );
  const pageSize = useStudioDraftText(String(query?.page_size ?? defaultQueryPageSize), (next) => {
    const size = Number(next);
    if (next.trim() === "" || !Number.isInteger(size) || size < 1 || size > maximumQueryPageSize)
      return `Page size: enter a whole number from 1 to ${maximumQueryPageSize}.`;
    return commit({ page_size: size }, `query-page-size:${moduleKey}:${queryKey}`) ?? true;
  });

  if (module === undefined || query === undefined)
    return (
      <p role="status" className="text-sm">
        This query is not in the draft any more. Choose another item in the Data panel.
      </p>
    );
  if (record === undefined)
    return (
      <p role="note" className="text-sm">
        This query lists records of another module&apos;s record type, so Studio does not edit it
        here.
      </p>
    );

  const fields = record.fields;
  const labelOf = (key: string) => fields.find((field) => field.key === key)?.label ?? key;
  const fieldOptions = (keys: readonly string[]) =>
    keys.map((key) => ({ value: key, label: labelOf(key) }));
  const unselected = fields
    .filter((field) => !query.select.includes(field.key))
    .map((field) => field.key);
  const sortable =
    query.group_by.length > 0
      ? query.group_by
      : fields.filter((field) => field.sortable).map((field) => field.key);
  const groupable = fields
    .filter((field) => queryGroupFieldTypes.has(field.type) && !query.group_by.includes(field.key))
    .map((field) => field.key);
  const takenColumns = () =>
    new Set([...query.select, ...query.aggregates.map((total) => total.alias)]);
  const totalFields = (operation: Operation) =>
    fields.filter((field) => queryTotalAccepts(operation, field.type)).map((field) => field.key);

  const changeFilter = (condition: ConditionNode | undefined, valid: boolean) => {
    if (!valid) {
      filter.hold(condition, unfinishedFilter);
      return;
    }
    const written = writeStudioQueryFilter(
      condition,
      (fieldId) => compiled?.find((field) => field.fieldId === fieldId)?.key,
    );
    if (written === undefined) {
      filter.hold(condition, "Filter: it names a field that is not in this record type any more.");
      return;
    }
    const result = run({ filter: written }, `query-filter:${moduleKey}:${queryKey}`);
    if (result.kind !== "changed") {
      filter.hold(condition, studioEditProblem(result) ?? unfinishedFilter);
      return;
    }
    const after = result.source.body.modules
      .find((item) => item.key === moduleKey)
      ?.queries.find((item) => item.key === queryKey);
    const read = after === undefined ? undefined : readFilter(after.filter);
    filter.applied(read?.kind === "read" ? read.condition : undefined);
  };
  // The filter is kept as it is when an input changes type, so it is checked again against the inputs
  // as they would be: an input whose type changed can leave a comparison with it that no longer fits.
  const retainedFilterProblems = (inputs: readonly InlineQueryInput[]): string[] => {
    if (query.filter === null) return [];
    if (reading?.kind === "read" && reading.condition !== undefined && compiled !== undefined) {
      const validation = validateStudioCondition(
        reading.condition,
        studioQueryFilterContext(compiled, filterable, inputs),
      );
      return validation.isValid
        ? []
        : validation.issues.map(
            (issue) =>
              `Filter${issue.pointer === "" ? "" : ` (${issue.pointer})`}: ${issue.message}.`,
          );
    }
    // Without the saved fields the filter can't be read here, so a changed input it uses is refused.
    const before = new Map(query.inputs.map((input) => [input.key, input.type] as const));
    return [...filterParameters(query.filter)].flatMap((key) => {
      const now = inputs.find((input) => input.key === key);
      return now !== undefined && before.get(key) !== undefined && before.get(key) !== now.type
        ? [
            `Filter: it compares a field with the input ${now.label}, whose type changed. Change the filter first, or keep the type.`,
          ]
        : [];
    });
  };
  const remove = async () => {
    setIssues([]);
    const result = deleteInlineQuery(source, moduleKey, queryKey);
    if (result.kind === "referenced") {
      setReferences(result.references);
      setRefusals((value) => value + 1);
      return;
    }
    if (result.kind === "invalid") {
      setIssues(result.issues);
      return;
    }
    if (
      !(await confirm({
        title: `Delete ${query.label || queryKey}?`,
        description:
          "The query leaves the draft. Nothing uses it, so no page, menu or flow changes.",
        confirmLabel: "Delete query",
      }))
    )
      return;
    const deleted = edit((current) => deleteInlineQuery(current, moduleKey, queryKey));
    if (deleted.kind === "changed") onDeleted(record.key);
    else if (deleted.kind === "referenced") {
      setReferences(deleted.references);
      setRefusals((value) => value + 1);
    } else setIssues([studioEditProblem(deleted) ?? "Nothing was deleted."]);
  };
  const addInput = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const label = newInput.label.trim();
    const key = deriveQueryKey(label, new Set(query.inputs.map((input) => input.key)));
    if (label === "" || key === undefined) {
      setIssues(["Inputs: enter the input's name, for example Company."]);
      return;
    }
    const recordType = recordTypes[0]?.key;
    if (newInput.type === "record_reference" && recordType === undefined) {
      setIssues(["Inputs: this application has no record type to choose."]);
      return;
    }
    const input = {
      key,
      label: label.slice(0, 60),
      required: true,
      type: newInput.type,
      ...(newInput.type === "record_reference" ? { record_types: [recordType] } : {}),
    } as InlineQueryInput;
    const problem = commit({ inputs: [...query.inputs, input] });
    setIssues(problem === undefined ? [] : [problem]);
    if (problem === undefined) setNewInput({ label: "", type: "text" });
  };
  const setInput = (index: number, next: Partial<Record<string, unknown>>) =>
    query.inputs.map((input, at) =>
      at === index ? ({ ...input, ...next } as InlineQueryInput) : input,
    );

  return (
    <section className="space-y-4" aria-label={`Query ${query.label ?? query.key}`}>
      <StudioField
        label="Name"
        hint={`Key: ${query.key}. It does not change when the name does. Lists ${record.plural_name}.`}
        error={name.problem === "" ? undefined : name.problem}
        onUndo={name.reset}
      >
        {(control) => (
          <Input
            {...control}
            value={name.text}
            maxLength={60}
            disabled={disabled}
            onChange={(event) => name.change(event.target.value)}
          />
        )}
      </StudioField>
      <StudioField
        label="Description"
        hint="What the query lists, for other builders. Optional."
        error={description.problem === "" ? undefined : description.problem}
        onUndo={description.reset}
      >
        {(control) => (
          <Textarea
            {...control}
            value={description.text}
            maxLength={1_000}
            disabled={disabled}
            onChange={(event) => description.change(event.target.value)}
          />
        )}
      </StudioField>

      <Section title="Columns" hint="The fields the query returns, in the order lists show them.">
        <ol className="list-none space-y-1" aria-label="Columns">
          {query.select.map((key, index) => (
            <Entry
              key={key}
              label={labelOf(key)}
              index={index}
              count={query.select.length}
              disabled={disabled}
              onMove={(by) => change({ select: moved(query.select, index, by) })}
              onRemove={() => change({ select: query.select.filter((item) => item !== key) })}
            >
              <span className="text-sm">{labelOf(key)}</span>
            </Entry>
          ))}
        </ol>
        {unselected.length === 0 ? (
          <p className="text-sm text-muted-foreground">Every field is a column.</p>
        ) : (
          <>
            <ScreenReaderLabel id={`query-${queryKey}-add-column`}>Add a column</ScreenReaderLabel>
            <StudioOptionControl
              id={`query-${queryKey}-add-column`}
              value=""
              unset="Add a column…"
              disabled={disabled}
              options={fieldOptions(unselected)}
              onChange={(key) => {
                if (key !== "") change({ select: [...query.select, key] });
              }}
            />
          </>
        )}
      </Section>

      <Section
        title="Filter"
        hint="Which records the query lists. Compare a field with a fixed value or with one of the query's inputs. Only filterable fields are offered; turn on filtering in a field's settings to use it here."
      >
        {reading?.kind === "unreadable" || context === undefined ? (
          <div className="space-y-2">
            <p role="note" className="text-sm">
              {!draftCompiles
                ? "The draft does not compile right now, so the filter controls can't read the record type's fields. Fix what the notice above names, or remove the filter."
                : reading?.kind === "unreadable"
                  ? reading.reason
                  : "The filter can't be edited here."}{" "}
              Until then the filter stays as it is.
            </p>
            {query.filter === null ? null : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => change({ filter: null })}
              >
                Remove the filter
              </Button>
            )}
          </div>
        ) : (
          <StudioConditionControls
            key={filter.epoch}
            label="Filter"
            context={context}
            {...(filter.value === undefined ? {} : { value: filter.value })}
            onChange={(condition, validation) => changeFilter(condition, validation.isValid)}
          />
        )}
        {filter.problem === "" ? null : (
          <p role="alert" className="text-sm text-destructive">
            {filter.problem}
          </p>
        )}
      </Section>

      <Section
        title="Sorting"
        hint={
          query.group_by.length > 0
            ? "A grouped query sorts by its groups."
            : "The order records are listed in. Only sortable fields are offered."
        }
      >
        <ol className="list-none space-y-1" aria-label="Sorting">
          {query.sort.map((sort, index) => (
            <Entry
              key={`${sort.field}:${index}`}
              label={labelOf(sort.field)}
              index={index}
              count={query.sort.length}
              disabled={disabled}
              onMove={(by) => change({ sort: moved(query.sort, index, by) })}
              onRemove={() => change({ sort: query.sort.filter((_, at) => at !== index) })}
            >
              <Label className="text-sm" htmlFor={`query-${queryKey}-sort-${index}`}>
                Sort by {labelOf(sort.field)}
              </Label>
              <StudioOptionControl
                id={`query-${queryKey}-sort-${index}`}
                value={sort.direction}
                disabled={disabled}
                options={directions}
                onChange={(direction) =>
                  change({
                    sort: query.sort.map((item, at) =>
                      at === index
                        ? { ...item, direction: direction as InlineQuerySort["direction"] }
                        : item,
                    ),
                  })
                }
              />
            </Entry>
          ))}
        </ol>
        {sortable.filter((key) => !query.sort.some((sort) => sort.field === key)).length ===
        0 ? null : (
          <>
            <ScreenReaderLabel id={`query-${queryKey}-add-sort`}>Add a sort</ScreenReaderLabel>
            <StudioOptionControl
              id={`query-${queryKey}-add-sort`}
              value=""
              unset="Add a sort…"
              disabled={disabled}
              options={fieldOptions(
                sortable.filter((key) => !query.sort.some((sort) => sort.field === key)),
              )}
              onChange={(key) => {
                if (key !== "")
                  change({ sort: [...query.sort, { field: key, direction: "ascending" }] });
              }}
            />
          </>
        )}
      </Section>

      <Section
        title="Grouping and totals"
        hint="Groups and totals make the query a summary: it then feeds Summary values, Charts and Boards. A Records table lists a query without them."
      >
        <ol className="list-none space-y-1" aria-label="Groups">
          {query.group_by.map((key, index) => (
            <Entry
              key={key}
              label={`group ${labelOf(key)}`}
              index={index}
              count={query.group_by.length}
              disabled={disabled}
              onMove={(by) => change({ group_by: moved(query.group_by, index, by) })}
              onRemove={() =>
                change({
                  group_by: query.group_by.filter((item) => item !== key),
                  sort: query.sort.filter((sort) => sort.field !== key),
                })
              }
            >
              <span className="text-sm">Group by {labelOf(key)}</span>
            </Entry>
          ))}
        </ol>
        {groupable.length === 0 ? null : (
          <>
            <ScreenReaderLabel id={`query-${queryKey}-add-group`}>Group by</ScreenReaderLabel>
            <StudioOptionControl
              id={`query-${queryKey}-add-group`}
              value=""
              unset="Group by…"
              disabled={disabled}
              options={fieldOptions(groupable)}
              onChange={(key) => {
                if (key === "") return;
                const group_by = [...query.group_by, key];
                // A grouped query sorts by its groups only.
                const kept = query.sort.filter((sort) => group_by.includes(sort.field));
                change({
                  group_by,
                  sort: kept.length > 0 ? kept : [{ field: key, direction: "ascending" }],
                });
              }}
            />
          </>
        )}
        <ol className="list-none space-y-1" aria-label="Totals">
          {query.aggregates.map((total, index) => (
            <Entry
              key={total.alias}
              label={`total ${index + 1}`}
              index={index}
              count={query.aggregates.length}
              disabled={disabled}
              onMove={(by) => change({ aggregates: moved(query.aggregates, index, by) })}
              onRemove={() =>
                change({ aggregates: query.aggregates.filter((_, at) => at !== index) })
              }
            >
              <Label className="text-sm" htmlFor={`query-${queryKey}-total-${index}`}>
                Total {index + 1}
              </Label>
              <StudioOptionControl
                id={`query-${queryKey}-total-${index}`}
                value={total.operation}
                disabled={disabled}
                options={(Object.keys(queryTotalOperationLabels) as Operation[]).map(
                  (operation) => ({
                    value: operation,
                    label: queryTotalOperationLabels[operation],
                  }),
                )}
                onChange={(next) => {
                  const operation = next as Operation;
                  const field =
                    operation === "count"
                      ? undefined
                      : total.field !== undefined && totalFields(operation).includes(total.field)
                        ? total.field
                        : totalFields(operation)[0];
                  const others = new Set([
                    ...query.select,
                    ...query.aggregates.filter((_, at) => at !== index).map((item) => item.alias),
                  ]);
                  const replaced = {
                    operation,
                    ...(field === undefined ? {} : { field }),
                    alias: deriveQueryTotalAlias(operation, field, others),
                  };
                  change({
                    aggregates: query.aggregates.map((item, at) =>
                      at === index ? (replaced as InlineQueryAggregate) : item,
                    ),
                  });
                }}
              />
              {total.operation === "count" ? null : (
                <>
                  <ScreenReaderLabel
                    id={`query-${queryKey}-total-${index}-field`}
                  >{`Field of total ${index + 1}`}</ScreenReaderLabel>
                  <StudioOptionControl
                    id={`query-${queryKey}-total-${index}-field`}
                    value={total.field ?? ""}
                    unset="Choose a field…"
                    disabled={disabled}
                    options={fieldOptions(totalFields(total.operation))}
                    onChange={(field) => {
                      const others = new Set([
                        ...query.select,
                        ...query.aggregates
                          .filter((_, at) => at !== index)
                          .map((item) => item.alias),
                      ]);
                      change({
                        aggregates: query.aggregates.map((item, at) =>
                          at === index
                            ? {
                                ...item,
                                ...(field === "" ? {} : { field }),
                                alias: deriveQueryTotalAlias(
                                  item.operation,
                                  field === "" ? undefined : field,
                                  others,
                                ),
                              }
                            : item,
                        ),
                      });
                    }}
                  />
                </>
              )}
            </Entry>
          ))}
        </ol>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || query.aggregates.length >= 20}
          onClick={() =>
            change({
              aggregates: [
                ...query.aggregates,
                {
                  operation: "count",
                  alias: deriveQueryTotalAlias("count", undefined, takenColumns()),
                },
              ],
            })
          }
        >
          <Icon name="plus" />
          Add a total
        </Button>
      </Section>

      <Section
        title="Page size"
        hint={`Records per page: ${defaultQueryPageSize} unless you choose otherwise, at most ${maximumQueryPageSize}.`}
      >
        <Input
          aria-label="Records per page"
          type="number"
          inputMode="numeric"
          min={1}
          max={maximumQueryPageSize}
          step={1}
          aria-invalid={pageSize.problem === "" ? undefined : true}
          value={pageSize.text}
          disabled={disabled}
          onChange={(event) => pageSize.change(event.target.value)}
        />
        {pageSize.problem === "" ? null : (
          <p role="alert" className="text-sm text-destructive">
            {pageSize.problem}
          </p>
        )}
      </Section>

      <Section
        title="Inputs"
        hint="Values a page gives the query when it lists records, for example the company a record page shows. The filter can compare a field with them."
      >
        <ul className="list-none space-y-1" aria-label="Inputs">
          {query.inputs.map((input, index) => (
            <li key={input.key} className="space-y-1 rounded-md border border-border p-2">
              <div className="flex items-start gap-1">
                <div className="min-w-0 flex-1">
                  <InputName
                    input={input}
                    disabled={disabled}
                    commit={(next) =>
                      next.trim() === ""
                        ? "Enter the input's name, for example Company."
                        : (commit(
                            { inputs: setInput(index, { label: next.trim().slice(0, 60) }) },
                            `query-input-label:${moduleKey}:${queryKey}:${input.key}`,
                          ) ?? true)
                    }
                  />
                </div>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove input ${input.label}`}
                  disabled={disabled}
                  onClick={() => change({ inputs: query.inputs.filter((_, at) => at !== index) })}
                >
                  <Icon name="close" />
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">Key: {input.key}</p>
              <ScreenReaderLabel
                id={`query-${queryKey}-input-${index}-type`}
              >{`Type of input ${input.label}`}</ScreenReaderLabel>
              <StudioOptionControl
                id={`query-${queryKey}-input-${index}-type`}
                value={input.type}
                disabled={disabled}
                options={inputTypes}
                onChange={(type) => {
                  // A new type starts without the old type's record types and validation.
                  const base = Object.fromEntries(
                    Object.entries(input).filter(
                      ([key]) => key !== "record_types" && key !== "validation",
                    ),
                  );
                  const inputs = query.inputs.map((item, at) =>
                    at !== index
                      ? item
                      : ({
                          ...base,
                          type,
                          ...(type === "record_reference"
                            ? { record_types: [recordTypes[0]?.key ?? ""] }
                            : {}),
                        } as InlineQueryInput),
                  );
                  const retained = retainedFilterProblems(inputs);
                  if (retained.length > 0) {
                    setIssues(retained);
                    return;
                  }
                  change({ inputs });
                }}
              />
              {input.type === "record_reference" && (
                <>
                  <ScreenReaderLabel
                    id={`query-${queryKey}-input-${index}-record`}
                  >{`Record type of input ${input.label}`}</ScreenReaderLabel>
                  <StudioOptionControl
                    id={`query-${queryKey}-input-${index}-record`}
                    value={(input as { record_types: string[] }).record_types[0] ?? ""}
                    disabled={disabled}
                    options={recordTypes.map((item) => ({ value: item.key, label: item.label }))}
                    onChange={(recordType) =>
                      change({ inputs: setInput(index, { record_types: [recordType] }) })
                    }
                  />
                </>
              )}
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`query-${queryKey}-input-${index}-required`}
                  checked={input.required}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    change({ inputs: setInput(index, { required: checked === true }) })
                  }
                />
                <Label
                  htmlFor={`query-${queryKey}-input-${index}-required`}
                  className="font-normal"
                >
                  The query needs it
                </Label>
              </div>
            </li>
          ))}
        </ul>
        <form className="flex flex-wrap items-end gap-2" onSubmit={addInput} aria-label="New input">
          <Input
            aria-label="Name of a new input"
            placeholder="New input, for example Company"
            value={newInput.label}
            maxLength={60}
            disabled={disabled}
            className="min-w-0 flex-1"
            onChange={(event) => setNewInput({ ...newInput, label: event.target.value })}
          />
          <ScreenReaderLabel id={`query-${queryKey}-new-input-type`}>
            Type of the new input
          </ScreenReaderLabel>
          <StudioOptionControl
            id={`query-${queryKey}-new-input-type`}
            value={newInput.type}
            disabled={disabled}
            options={inputTypes}
            onChange={(type) => setNewInput({ ...newInput, type: type as InputType })}
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={disabled || newInput.label.trim() === ""}
          >
            Add input
          </Button>
        </form>
      </Section>

      {issues.length === 0 ? null : (
        <ul
          className="space-y-1 text-sm text-destructive"
          aria-label="Why the query was not changed"
          role="alert"
        >
          {issues.map((issue, index) => (
            <li key={index} className="break-words">
              {issue}
            </li>
          ))}
        </ul>
      )}
      <section className="space-y-2 border-t border-border pt-3" aria-label="Delete">
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={disabled}
          onClick={() => {
            void remove();
          }}
        >
          Delete query
        </Button>
        <StudioReferencesAlert
          key={refusals}
          name={query.label || query.key}
          action="deleted"
          references={references}
        />
      </section>
      {confirmDialog}
    </section>
  );
}

/** Names a new query of a record type; the query starts as a plain list of it. */
export function StudioNewQueryForm({
  source,
  moduleKey,
  recordKey,
  disabled,
  edit,
  onCreated,
}: Readonly<{
  source: Source;
  moduleKey: string;
  recordKey: string;
  disabled: boolean;
  edit: StudioDataEdit;
  onCreated: (queryKey: string) => void;
}>) {
  const module = source.body.modules.find((item) => item.key === moduleKey);
  const [label, setLabel] = useState("");
  const [issues, setIssues] = useState<readonly string[]>([]);
  const key = deriveQueryKey(label, new Set(module?.queries.map((query) => query.key) ?? []));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = edit((current) =>
      createInlineQuery(current, { moduleKey, recordKey, label, key: key ?? "" }),
    );
    if (result.kind !== "changed") {
      setIssues([studioEditProblem(result) ?? "The query was not added."]);
      return;
    }
    onCreated(result.queryKey);
  };
  return (
    <form className="space-y-2" onSubmit={submit} aria-label="New query">
      <StudioField
        label="Query name"
        hint={
          key === undefined
            ? "For example Open companies. A key is made from it."
            : `Its key will be "${key}". It does not change later.`
        }
      >
        {(control) => (
          <Input
            {...control}
            value={label}
            maxLength={60}
            disabled={disabled}
            onChange={(event) => {
              setLabel(event.target.value);
              setIssues([]);
            }}
          />
        )}
      </StudioField>
      <Button type="submit" size="sm" disabled={disabled || label.trim() === ""}>
        Add query
      </Button>
      {issues.length === 0 ? null : (
        <ul role="alert" className="space-y-1 text-sm text-destructive">
          {issues.map((issue, index) => (
            <li key={index} className="break-words">
              {issue}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
