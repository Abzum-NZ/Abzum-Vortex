"use client";
import { Label } from "../components/label";
import { useId } from "react";
import { FieldError } from "../components/field";
import { Input } from "@vortex/ui/components/input";
import { Textarea } from "@vortex/ui/components/textarea";
import { StudioOptionControl } from "./studio-setting-controls";
import { useDateFormatOptions } from "../display/date-format-context";
import {
  currentIso4217Alpha3CodeSetV2026_01_01,
  jsonValueSchema,
  isRecord,
  type JsonValue,
} from "@vortex/platform/schema";
import {
  type ConditionOperand,
  type ConditionPath,
  type StudioConditionSemanticType,
  type StudioConditionValidation,
  errorForPath,
  instantFromLocalDateTimeInput,
  literalInputValue,
  literalMatchesType,
  localDateTimeInputValue,
} from "./condition-model";

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
      <Label className="flex flex-col items-stretch gap-2">
        {label}
        <Textarea
          key={JSON.stringify(operand.value)}
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : errorId}
          defaultValue={JSON.stringify(Array.isArray(operand.value) ? operand.value : [], null, 2)}
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
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </Label>
    );
  if (semanticType === "yes_no")
    return (
      <Label className="flex flex-col items-stretch gap-2">
        {label}
        <StudioOptionControl
          aria-label={label}
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : errorId}
          value={operand.value === true ? "true" : "false"}
          disabled={false}
          options={[
            { value: "true", label: "Yes" },
            { value: "false", label: "No" },
          ]}
          onChange={(next) => onCommit(next === "true")}
        />
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </Label>
    );

  if (semanticType === "whole_number")
    return (
      <Label className="flex flex-col items-stretch gap-2">
        {label}
        <Input
          key={JSON.stringify(operand.value)}
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : errorId}
          type="text"
          inputMode={semanticType === "whole_number" ? "numeric" : "decimal"}
          defaultValue={typeof operand.value === "number" ? String(operand.value) : ""}
          onBlur={(event) => {
            const next = event.currentTarget.value;
            if (next === "") {
              event.currentTarget.setCustomValidity("");
              onCommit(null);
            } else {
              const numericValue = Number(next);
              const valid =
                Number.isFinite(numericValue) &&
                (semanticType !== "whole_number" || Number.isSafeInteger(numericValue));
              if (valid) {
                event.currentTarget.setCustomValidity("");
                onCommit(numericValue);
              } else {
                const message =
                  semanticType === "whole_number"
                    ? "Enter a whole number"
                    : "Enter a finite number";
                event.currentTarget.setCustomValidity(message);
                event.currentTarget.reportValidity();
                onInvalid(message);
              }
            }
          }}
        />
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </Label>
    );

  if (semanticType === "decimal_number")
    return (
      <Label className="flex flex-col items-stretch gap-2">
        {label}
        <Input
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : errorId}
          inputMode="decimal"
          type="text"
          value={literalInputValue(operand.value)}
          onChange={(event) => onCommit(event.currentTarget.value)}
        />
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </Label>
    );

  if (semanticType === "date")
    return (
      <Label className="flex flex-col items-stretch gap-2">
        {label}
        <Input
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : errorId}
          type="date"
          value={typeof operand.value === "string" ? operand.value : ""}
          onChange={(event) => onCommit(event.currentTarget.value)}
        />
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </Label>
    );

  if (semanticType === "date_time")
    return (
      <fieldset className="space-y-4">
        <legend>{label}</legend>
        <Label className="flex flex-col items-stretch gap-2">
          Local date and time (whole seconds)
          <Input
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
        </Label>
        <Label className="flex flex-col items-stretch gap-2">
          Exact instant (ISO 8601 with offset)
          <Input
            aria-invalid={error !== undefined}
            aria-describedby={error === undefined ? undefined : errorId}
            type="text"
            value={literalInputValue(operand.value)}
            onChange={(event) => onCommit(event.currentTarget.value)}
          />
        </Label>
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </fieldset>
    );

  if (semanticType === "money") {
    const current = isRecord(operand.value) ? operand.value : {};
    const amount = typeof current.amount === "string" ? current.amount : "";
    const currency = typeof current.currency === "string" ? current.currency : "";
    return (
      <fieldset className="space-y-4">
        <legend>{label}</legend>
        <Label className="flex flex-col items-stretch gap-2">
          Amount
          <Input
            aria-invalid={error !== undefined}
            aria-describedby={error === undefined ? undefined : errorId}
            inputMode="decimal"
            type="text"
            value={amount}
            onChange={(event) => onCommit({ amount: event.currentTarget.value, currency })}
          />
        </Label>
        <Label className="flex flex-col items-stretch gap-2">
          Currency
          <StudioOptionControl
            aria-label="Currency"
            aria-invalid={error !== undefined}
            aria-describedby={error === undefined ? undefined : errorId}
            value={currency}
            disabled={false}
            unset="Choose a currency…"
            options={currencyCodes.map((code) => ({ value: code, label: code }))}
            onChange={(next) => onCommit({ amount, currency: next })}
          />
        </Label>
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </fieldset>
    );
  }

  if (semanticType === "text_collection")
    return (
      <Label className="flex flex-col items-stretch gap-2">
        {label} (one item per line)
        <Textarea
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : errorId}
          value={Array.isArray(operand.value) ? operand.value.map(String).join("\n") : ""}
          onChange={(event) => onCommit(event.currentTarget.value.split("\n"))}
        />
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </Label>
    );

  if (
    semanticType === "opaque_json" ||
    semanticType === "record_reference" ||
    semanticType === "organization_account_reference"
  )
    return (
      <Label className="flex flex-col items-stretch gap-2">
        {label} (JSON value)
        <Textarea
          key={JSON.stringify(operand.value)}
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : errorId}
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
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </Label>
    );

  return (
    <Label className="flex flex-col items-stretch gap-2">
      {label}
      <Input
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : errorId}
        type="text"
        value={typeof operand.value === "string" ? operand.value : ""}
        onChange={(event) => onCommit(event.currentTarget.value)}
      />
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </Label>
  );
}
