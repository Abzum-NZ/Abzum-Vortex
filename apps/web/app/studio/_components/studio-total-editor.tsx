"use client";
import { useMemo } from "react";
import {
  calculationResultTypeLabels,
  describeTotal,
  queryTotalOperationLabels,
  totalFieldAccepts,
  totalFilterKeys,
  totalResultType,
  typedDecimalPlaces,
  type ModuleField,
  type TotalOperation,
  type TotalRelationship,
  type TotalSettings,
} from "@vortex/platform/schema";
import { StudioOptionControl } from "@vortex/ui/studio";
import { Input } from "@vortex/ui/components/input";
import { StudioField } from "./studio-field";
import { StudioFormulaCondition } from "./studio-formula-condition";

const operationOptions = (
  Object.keys(queryTotalOperationLabels).filter(
    (value) => value !== "distinct_count",
  ) as TotalOperation[]
).map((value) => ({ value, label: queryTotalOperationLabels[value] }));

/**
 * A total's settings kept consistent with its operation and field: a count takes no field, the
 * result follows from the operation and field (one rule, the query totals' rule), an average keeps
 * its decimal places, and only a sum of money keeps a currency.
 */
const settled = (
  settings: TotalSettings,
  relationship: TotalRelationship | undefined,
): TotalSettings => {
  const { field: fieldKey, currency, decimal_places: places, ...rest } = settings;
  const field = relationship?.fields.find((item) => item.key === fieldKey);
  const keptField =
    relationship === undefined ||
    field === undefined ||
    !totalFieldAccepts(settings.operation, field, relationship)
      ? undefined
      : field;
  const { filter, ...others } = rest;
  return {
    ...others,
    ...(filter === undefined ? {} : { filter }),
    result_type: totalResultType(settings.operation, keptField) ?? settings.result_type,
    ...(settings.operation === "count" || fieldKey === undefined ? {} : { field: fieldKey }),
    ...(settings.operation === "sum" &&
    keptField !== undefined &&
    totalResultType("sum", keptField) === "money" &&
    currency !== undefined
      ? { currency }
      : {}),
    ...(settings.operation === "average" ? { decimal_places: places ?? 2 } : {}),
  } as TotalSettings;
};

/**
 * The total editor of a total field: which related records it totals (a link to this one from a
 * record type of its module), the operation and the field, as a query's totals offer them, and an optional
 * filter of the related records. The result follows from the operation and the field.
 */
export function StudioTotalEditor({
  settings,
  relationships,
  compiledOf,
  disabled,
  onChange,
}: Readonly<{
  settings: TotalSettings;
  /** The links from this module's record types to this record type, whose records a total can take. */
  relationships: readonly TotalRelationship[];
  /** The saved draft's compiled fields of a record type, by its qualified key, for the filter's controls. */
  compiledOf: (recordType: string) => readonly ModuleField[] | undefined;
  disabled: boolean;
  /** The changed settings, and whether a filter in them is complete. */
  onChange: (settings: TotalSettings, filterValid: boolean) => void;
}>) {
  const relationship = relationships.find((item) => item.reference === settings.relationship);
  // The filter compares only fields people can filter by, as publication requires.
  const filterKeys = useMemo(
    () => (relationship === undefined ? new Set<string>() : totalFilterKeys(relationship)),
    [relationship],
  );
  const set = (next: Partial<TotalSettings>, filterValid = true) => {
    const nextRelationship = relationships.find(
      (item) => item.reference === (next.relationship ?? settings.relationship),
    );
    onChange(settled({ ...settings, ...next } as TotalSettings, nextRelationship), filterValid);
  };
  const accepted =
    relationship === undefined
      ? []
      : relationship.fields
          .filter((field) => totalFieldAccepts(settings.operation, field, relationship))
          .map((field) => ({ value: field.key, label: field.label }));
  const totalsMoney =
    settings.operation === "sum" &&
    totalResultType(
      "sum",
      relationship?.fields.find((field) => field.key === settings.field),
    ) === "money";
  // A new total of a record type no link points at has no relationship yet.
  const reference = (settings.relationship as string | undefined) ?? "";
  const recordType = reference.slice(0, Math.max(0, reference.lastIndexOf(".")));

  return (
    <div className="space-y-3">
      <StudioField
        label="Related records"
        hint={
          relationships.length === 0
            ? "No record type of this module links to this one yet. Add a link field to one first."
            : "The records of this module that link to this one."
        }
      >
        {(control) => (
          <StudioOptionControl
            id={control.id}
            value={reference}
            unset="Choose the related records…"
            disabled={disabled}
            options={relationships.map((item) => ({ value: item.reference, label: item.label }))}
            onChange={(reference) => {
              // Another link brings other fields: the field and filter start again.
              const rest: Partial<TotalSettings> = { ...settings };
              delete rest.field;
              delete rest.filter;
              onChange(
                settled(
                  { ...rest, relationship: reference } as TotalSettings,
                  relationships.find((item) => item.reference === reference),
                ),
                true,
              );
            }}
          />
        )}
      </StudioField>
      <StudioField label="Total">
        {(control) => (
          <StudioOptionControl
            id={control.id}
            value={settings.operation}
            disabled={disabled}
            options={operationOptions}
            onChange={(operation) => set({ operation: operation as TotalOperation })}
          />
        )}
      </StudioField>
      {settings.operation === "count" ? null : (
        <StudioField
          label="Field of the related records"
          hint={
            accepted.length === 0
              ? `No field of the related records can be taken the ${queryTotalOperationLabels[settings.operation].toLowerCase()} of.`
              : undefined
          }
        >
          {(control) => (
            <StudioOptionControl
              id={control.id}
              value={settings.field ?? ""}
              unset="Choose a field…"
              disabled={disabled}
              options={accepted}
              onChange={(field) => set(field === "" ? { field: undefined } : { field })}
            />
          )}
        </StudioField>
      )}
      {settings.operation === "average" && (
        <StudioField
          label="Decimal places"
          hint="How many decimal places the average keeps, from 0 to 12."
        >
          {(control) => (
            <Input
              {...control}
              type="number"
              min={0}
              max={12}
              step={1}
              disabled={disabled}
              value={settings.decimal_places ?? ""}
              onChange={(event) => set({ decimal_places: typedDecimalPlaces(event.target.value) })}
            />
          )}
        </StudioField>
      )}
      {totalsMoney && (
        <StudioField
          label="Currency"
          hint="Optional. Three capital letters, for example NZD. With a currency, no related records total 0 in it, and amounts in another currency are refused."
        >
          {(control) => (
            <Input
              {...control}
              maxLength={3}
              disabled={disabled}
              value={settings.currency ?? ""}
              onChange={(event) => {
                const currency = event.target.value.toUpperCase();
                set({ currency: currency === "" ? undefined : currency });
              }}
            />
          )}
        </StudioField>
      )}
      <section className="space-y-2" aria-label="Filter of the related records">
        <h4 className="text-sm font-semibold">Only related records that match</h4>
        <p className="text-xs text-muted-foreground">
          Optional. Leave it empty to take every related record.
        </p>
        {relationship === undefined ? (
          <p className="text-sm text-muted-foreground">Choose the related records first.</p>
        ) : filterKeys.size === 0 && settings.filter === undefined ? (
          <p className="text-sm text-muted-foreground">
            No field of {relationship.recordName} can be filtered by. Tick &ldquo;People can filter
            by it&rdquo; on one first.
          </p>
        ) : (
          <StudioFormulaCondition
            key={reference}
            label="Filter of the related records"
            condition={settings.filter}
            compiled={compiledOf(recordType)}
            fieldKeys={filterKeys}
            disabled={disabled}
            onChange={(filter, valid) => set({ filter: filter as TotalSettings["filter"] }, valid)}
          />
        )}
      </section>
      <p className="break-words rounded-md bg-muted p-2 text-sm" aria-label="The total reads">
        <span className="font-medium">{calculationResultTypeLabels[settings.result_type]} =</span>{" "}
        {describeTotal(settings, relationship)}
      </p>
    </div>
  );
}
