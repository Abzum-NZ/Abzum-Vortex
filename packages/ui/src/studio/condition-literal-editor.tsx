"use client";
import { useId } from "react";
import { FieldError } from "../components/field";
import { Input } from "@vortex/ui/components/input";
import { Textarea } from "@vortex/ui/components/textarea";
import { NativeSelect } from "@vortex/ui/components/native-select";
import { useDateFormatOptions } from "../display/date-format-context";
import { jsonValueSchema, isRecord, type JsonValue } from "@vortex/platform/schema";
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
  pointerForPath,
} from "./condition-model";

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
      : `Value${semanticType ? ` (${semanticType.replaceAll("_", " ")})` : ""}`;
  const collectionMessage =
    collectionElementType === undefined
      ? "Enter a list with values of the selected type"
      : `Enter a list of ${collectionTypeLabel(collectionElementType)} values`;

  if (collectionElementType && collectionElementType !== "text")
    return (
      <label className="flex flex-col gap-2 text-sm">
        {label}
        <Textarea
          key={`${pointerForPath(path)}:${JSON.stringify(operand.value)}`}
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
      </label>
    );
  if (semanticType === "yes_no")
    return (
      <label className="flex flex-col gap-2 text-sm">
        {label}
        <NativeSelect
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : errorId}
          value={operand.value === true ? "true" : "false"}
          onChange={(event) => onCommit(event.currentTarget.value === "true")}
        >
          <option value="true">True</option>
          <option value="false">False</option>
        </NativeSelect>
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </label>
    );

  if (semanticType === "whole_number")
    return (
      <label className="flex flex-col gap-2 text-sm">
        {label}
        <Input
          key={`${pointerForPath(path)}:${JSON.stringify(operand.value)}`}
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
      </label>
    );

  if (semanticType === "decimal_number")
    return (
      <label className="flex flex-col gap-2 text-sm">
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
      </label>
    );

  if (semanticType === "date")
    return (
      <label className="flex flex-col gap-2 text-sm">
        {label}
        <Input
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : errorId}
          type="date"
          value={typeof operand.value === "string" ? operand.value : ""}
          onChange={(event) => onCommit(event.currentTarget.value)}
        />
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </label>
    );

  if (semanticType === "date_time")
    return (
      <fieldset className="space-y-4">
        <legend>{label}</legend>
        <label className="flex flex-col gap-2 text-sm">
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
        </label>
        <label className="flex flex-col gap-2 text-sm">
          Exact instant (ISO 8601 with offset)
          <Input
            aria-invalid={error !== undefined}
            aria-describedby={error === undefined ? undefined : errorId}
            type="text"
            value={literalInputValue(operand.value)}
            onChange={(event) => onCommit(event.currentTarget.value)}
          />
        </label>
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
        <label className="flex flex-col gap-2 text-sm">
          Amount
          <Input
            aria-invalid={error !== undefined}
            aria-describedby={error === undefined ? undefined : errorId}
            inputMode="decimal"
            type="text"
            value={amount}
            onChange={(event) => onCommit({ amount: event.currentTarget.value, currency })}
          />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          Currency
          <Input
            aria-invalid={error !== undefined}
            aria-describedby={error === undefined ? undefined : errorId}
            maxLength={3}
            type="text"
            value={currency}
            onChange={(event) =>
              onCommit({ amount, currency: event.currentTarget.value.toUpperCase() })
            }
          />
        </label>
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </fieldset>
    );
  }

  if (semanticType === "text_collection")
    return (
      <label className="flex flex-col gap-2 text-sm">
        {label} (one item per line)
        <Textarea
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : errorId}
          value={Array.isArray(operand.value) ? operand.value.map(String).join("\n") : ""}
          onChange={(event) => onCommit(event.currentTarget.value.split("\n"))}
        />
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </label>
    );

  if (
    semanticType === "opaque_json" ||
    semanticType === "record_reference" ||
    semanticType === "organization_account_reference"
  )
    return (
      <label className="flex flex-col gap-2 text-sm">
        {label} (JSON value)
        <Textarea
          key={`${pointerForPath(path)}:${JSON.stringify(operand.value)}`}
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
      </label>
    );

  return (
    <label className="flex flex-col gap-2 text-sm">
      {label}
      <Input
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : errorId}
        type="text"
        value={typeof operand.value === "string" ? operand.value : ""}
        onChange={(event) => onCommit(event.currentTarget.value)}
      />
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </label>
  );
}
