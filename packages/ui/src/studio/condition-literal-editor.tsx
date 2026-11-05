"use client";
import { useId } from "react";
import { FieldError, FieldGroup, FieldLegend, FieldSet } from "../components/field";
import { Input } from "@vortex/ui/components/input";
import { Textarea } from "@vortex/ui/components/textarea";
import { StudioField, useStudioFieldProblem } from "./studio-field";
import { StudioOptionControl } from "./studio-setting-basic-controls";
import { useDateFormatOptions } from "../display/date-format-context";
import {
  currentIso4217Alpha3CodeSetV2026_01_01,
  jsonValueSchema,
  isRecord,
  type JsonValue,
  type ConditionOperand,
  type ConditionPath,
  type StudioConditionSemanticType,
  type StudioConditionValidation,
  errorForPath,
  instantFromLocalDateTimeInput,
  literalInputValue,
  literalMatchesType,
  localDateTimeInputValue,
} from "@vortex/platform/schema";

const currencyCodes = [...currentIso4217Alpha3CodeSetV2026_01_01].sort();

type LiteralEditorProps = Readonly<{
  operand: Extract<ConditionOperand, { source: "value" }>;
  semanticType: StudioConditionSemanticType | undefined;
  collectionElementType?: Exclude<StudioConditionSemanticType, "text_collection" | "opaque_json">;
  path: ConditionPath;
  validation: StudioConditionValidation;
  onCommit: (value: JsonValue) => void;
  onInvalid: (message: string) => void;
}>;

const collectionTypeLabel = (
  type: Exclude<StudioConditionSemanticType, "text_collection" | "opaque_json">,
): string => {
  switch (type) {
    case "whole_number":
      return "whole numbers";
    case "decimal_number":
      return "decimal numbers";
    case "money":
      return "amounts of money";
    case "yes_no":
      return "yes or no answers";
    case "date":
      return "dates";
    case "date_time":
      return "dates and times";
    case "record_reference":
      return "records";
    case "organization_account_reference":
      return "people";
    default:
      return type;
  }
};

/** The kind of value, in words. */
const typeLabel = (type: StudioConditionSemanticType): string => {
  switch (type) {
    case "text":
      return "text";
    case "text_collection":
      return "list of text";
    case "opaque_json":
      return "data";
    case "organization_account_reference":
      return "person";
    case "record_reference":
      return "record";
    case "yes_no":
      return "yes or no";
    case "money":
      return "amount of money";
    case "date_time":
      return "date and time";
    default:
      return collectionTypeLabel(type).replace(/s$/u, "");
  }
};

export function LiteralEditor({
  operand,
  semanticType,
  collectionElementType,
  path,
  validation,
  onCommit,
  onInvalid,
}: LiteralEditorProps) {
  const { timeZone } = useDateFormatOptions();
  const errorId = useId();
  // One zone both shows and reads the local date and time, so an edit keeps the instant it names.
  const inputTimeZone = timeZone ?? "UTC";
  const error = errorForPath(validation, path);
  // The grouped literals (date and time, money) report as a whole; every other literal reports
  // through its own StudioField.
  useStudioFieldProblem(
    errorId,
    semanticType === "date_time" || semanticType === "money" ? error : undefined,
  );
  const label =
    collectionElementType && collectionElementType !== "text"
      ? `Values (list of ${collectionTypeLabel(collectionElementType)})`
      : `Value${semanticType ? ` (${typeLabel(semanticType)})` : ""}`;
  const collectionMessage =
    collectionElementType === undefined
      ? "Enter a list with values of the selected type"
      : `Enter a list of ${collectionTypeLabel(collectionElementType)} values`;

  if (collectionElementType && collectionElementType !== "text")
    return (
      <StudioField label={label} error={error}>
        {(control) => (
          <Textarea
            {...control}
            key={JSON.stringify(operand.value)}
            defaultValue={JSON.stringify(
              Array.isArray(operand.value) ? operand.value : [],
              null,
              2,
            )}
            onBlur={(event) => {
              try {
                const parsed = jsonValueSchema.safeParse(JSON.parse(event.currentTarget.value));
                if (
                  !parsed.success ||
                  !Array.isArray(parsed.data) ||
                  !parsed.data.every((value) => literalMatchesType(value, collectionElementType))
                )
                  throw new Error(collectionMessage);
                event.currentTarget.setCustomValidity("");
                onCommit(parsed.data);
              } catch {
                const message = collectionMessage;
                event.currentTarget.setCustomValidity(message);
                event.currentTarget.reportValidity();
                onInvalid(message);
              }
            }}
          />
        )}
      </StudioField>
    );
  if (semanticType === "yes_no")
    return (
      <StudioField label={label} error={error}>
        {(control) => (
          <StudioOptionControl
            {...control}
            aria-label={label}
            value={operand.value === true ? "true" : "false"}
            disabled={false}
            options={[
              { value: "true", label: "Yes" },
              { value: "false", label: "No" },
            ]}
            onChange={(next) => onCommit(next === "true")}
          />
        )}
      </StudioField>
    );

  if (semanticType === "whole_number")
    return (
      <StudioField label={label} error={error}>
        {(control) => (
          <Input
            {...control}
            key={JSON.stringify(operand.value)}
            type="text"
            inputMode="numeric"
            defaultValue={typeof operand.value === "number" ? String(operand.value) : ""}
            onBlur={(event) => {
              const next = event.currentTarget.value;
              if (next === "") {
                event.currentTarget.setCustomValidity("");
                onCommit(null);
              } else {
                const numericValue = Number(next);
                if (Number.isFinite(numericValue) && Number.isSafeInteger(numericValue)) {
                  event.currentTarget.setCustomValidity("");
                  onCommit(numericValue);
                } else {
                  const message = "Enter a whole number";
                  event.currentTarget.setCustomValidity(message);
                  event.currentTarget.reportValidity();
                  onInvalid(message);
                }
              }
            }}
          />
        )}
      </StudioField>
    );

  if (semanticType === "decimal_number")
    return (
      <StudioField label={label} error={error}>
        {(control) => (
          <Input
            {...control}
            inputMode="decimal"
            type="text"
            value={literalInputValue(operand.value)}
            onChange={(event) => onCommit(event.currentTarget.value)}
          />
        )}
      </StudioField>
    );

  if (semanticType === "date")
    return (
      <StudioField label={label} error={error}>
        {(control) => (
          <Input
            {...control}
            type="date"
            value={typeof operand.value === "string" ? operand.value : ""}
            onChange={(event) => onCommit(event.currentTarget.value)}
          />
        )}
      </StudioField>
    );

  if (semanticType === "date_time")
    return (
      <FieldSet data-invalid={error === undefined ? undefined : true}>
        <FieldLegend variant="label">{label}</FieldLegend>
        <FieldGroup>
          <StudioField label="Local date and time (whole seconds)">
            {(control) => (
              <Input
                {...control}
                aria-invalid={error !== undefined}
                aria-describedby={error === undefined ? undefined : errorId}
                type="datetime-local"
                step={1}
                value={localDateTimeInputValue(operand.value, inputTimeZone)}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  if (next === "") {
                    onCommit(null);
                    return;
                  }
                  const instant = instantFromLocalDateTimeInput(next, inputTimeZone);
                  if (instant === undefined) {
                    onInvalid("Enter a valid date and time");
                    return;
                  }
                  onCommit(instant);
                }}
              />
            )}
          </StudioField>
          <StudioField label="Exact instant (ISO 8601 with offset)">
            {(control) => (
              <Input
                {...control}
                aria-invalid={error !== undefined}
                aria-describedby={error === undefined ? undefined : errorId}
                type="text"
                value={literalInputValue(operand.value)}
                onChange={(event) => onCommit(event.currentTarget.value)}
              />
            )}
          </StudioField>
        </FieldGroup>
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </FieldSet>
    );

  if (semanticType === "money") {
    const current = isRecord(operand.value) ? operand.value : {};
    const amount = typeof current.amount === "string" ? current.amount : "";
    const currency = typeof current.currency === "string" ? current.currency : "";
    return (
      <FieldSet data-invalid={error === undefined ? undefined : true}>
        <FieldLegend variant="label">{label}</FieldLegend>
        <FieldGroup>
          <StudioField label="Amount">
            {(control) => (
              <Input
                {...control}
                aria-invalid={error !== undefined}
                aria-describedby={error === undefined ? undefined : errorId}
                inputMode="decimal"
                type="text"
                value={amount}
                onChange={(event) => onCommit({ amount: event.currentTarget.value, currency })}
              />
            )}
          </StudioField>
          <StudioField label="Currency">
            {(control) => (
              <StudioOptionControl
                {...control}
                aria-label="Currency"
                aria-invalid={error !== undefined}
                aria-describedby={error === undefined ? undefined : errorId}
                value={currency}
                disabled={false}
                unset="Choose a currency…"
                options={currencyCodes.map((code) => ({ value: code, label: code }))}
                onChange={(next) => onCommit({ amount, currency: next })}
              />
            )}
          </StudioField>
        </FieldGroup>
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </FieldSet>
    );
  }

  if (semanticType === "text_collection")
    return (
      <StudioField label={`${label} (one item per line)`} error={error}>
        {(control) => (
          <Textarea
            {...control}
            value={Array.isArray(operand.value) ? operand.value.map(String).join("\n") : ""}
            onChange={(event) => onCommit(event.currentTarget.value.split("\n"))}
          />
        )}
      </StudioField>
    );

  if (
    semanticType === "opaque_json" ||
    semanticType === "record_reference" ||
    semanticType === "organization_account_reference"
  )
    return (
      <StudioField label={`${label} (JSON value)`} error={error}>
        {(control) => (
          <Textarea
            {...control}
            key={JSON.stringify(operand.value)}
            defaultValue={JSON.stringify(operand.value)}
            onBlur={(event) => {
              try {
                const parsed = jsonValueSchema.safeParse(JSON.parse(event.currentTarget.value));
                if (!parsed.success) throw new Error("Enter a valid JSON value");
                event.currentTarget.setCustomValidity("");
                onCommit(parsed.data);
              } catch {
                const message = "Enter a valid JSON value";
                event.currentTarget.setCustomValidity(message);
                event.currentTarget.reportValidity();
                onInvalid(message);
              }
            }}
          />
        )}
      </StudioField>
    );

  return (
    <StudioField label={label} error={error}>
      {(control) => (
        <Input
          {...control}
          type="text"
          value={typeof operand.value === "string" ? operand.value : ""}
          onChange={(event) => onCommit(event.currentTarget.value)}
        />
      )}
    </StudioField>
  );
}
