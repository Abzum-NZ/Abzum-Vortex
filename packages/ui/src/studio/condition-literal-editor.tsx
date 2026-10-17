"use client";
import { Input } from "@vortex/ui/components/input";
import { Textarea } from "@vortex/ui/components/textarea";
import { NativeSelect } from "@vortex/ui/components/native-select";
import { useDateFormatOptions } from "../display/date-format-context";
import {
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
  // One zone both shows and reads the local date and time, so an edit keeps the instant it names.
  const inputTimeZone = timeZone ?? "UTC";
  const error = errorForPath(validation, path);
  const label = collectionElementType && collectionElementType !== "text"
    ? `Literal value (${collectionElementType.replaceAll("_", " ")} list, JSON array)`
    : `Literal value${semanticType ? ` (${semanticType.replaceAll("_", " ")})` : ""}`;

  if (collectionElementType && collectionElementType !== "text")
    return (
      <label>
        {label}
        <Textarea
          key={`${pointerForPath(path)}:${JSON.stringify(operand.value)}`}
          aria-invalid={error !== undefined}
          defaultValue={JSON.stringify(Array.isArray(operand.value) ? operand.value : [], null, 2)}
          onBlur={(event) => {
            try {
              const parsed = jsonValueSchema.safeParse(JSON.parse(event.currentTarget.value));
              if (
                !parsed.success ||
                !Array.isArray(parsed.data) ||
                !parsed.data.every((value) => literalMatchesType(value, collectionElementType))
              )
                throw new Error("Enter a JSON array with items of the selected type");
              event.currentTarget.setCustomValidity("");
              onCommit(parsed.data);
            } catch {
              const message = "Enter a JSON array with items of the selected type";
              event.currentTarget.setCustomValidity(message);
              event.currentTarget.reportValidity();
              onInvalid(message);
            }
          }}
        />
        {error && <span role="alert">{error}</span>}
      </label>
    );
  if (semanticType === "boolean")
    return (
      <label>
        {label}
        <NativeSelect
          aria-invalid={error !== undefined}
          value={operand.value === true ? "true" : "false"}
          onChange={(event) => onCommit(event.currentTarget.value === "true")}
        >
          <option value="true">True</option>
          <option value="false">False</option>
        </NativeSelect>
        {error && <span role="alert">{error}</span>}
      </label>
    );

  if (semanticType === "number" || semanticType === "whole_number")
    return (
      <label>
        {label}
        <Input
          key={`${pointerForPath(path)}:${JSON.stringify(operand.value)}`}
          aria-invalid={error !== undefined}
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
              const valid = Number.isFinite(numericValue) &&
                (semanticType !== "whole_number" || Number.isInteger(numericValue));
              if (valid) {
                event.currentTarget.setCustomValidity("");
                onCommit(numericValue);
              } else {
                const message = semanticType === "whole_number"
                  ? "Enter a whole number"
                  : "Enter a finite number";
                event.currentTarget.setCustomValidity(message);
                event.currentTarget.reportValidity();
                onInvalid(message);
              }
            }
          }}
        />
        {error && <span role="alert">{error}</span>}
      </label>
    );

  if (semanticType === "decimal_number")
    return (
      <label>
        {label}
        <Input
          aria-invalid={error !== undefined}
          inputMode="decimal"
          type="text"
          value={literalInputValue(operand.value)}
          onChange={(event) => onCommit(event.currentTarget.value)}
        />
        {error && <span role="alert">{error}</span>}
      </label>
    );

  if (semanticType === "date")
    return (
      <label>
        {label}
        <Input
          aria-invalid={error !== undefined}
          type="date"
          value={typeof operand.value === "string" ? operand.value : ""}
          onChange={(event) => onCommit(event.currentTarget.value)}
        />
        {error && <span role="alert">{error}</span>}
      </label>
    );

  if (semanticType === "date_time")
    return (
      <fieldset>
        <legend>{label}</legend>
        <label>
          Local date and time (whole seconds)
          <Input
            aria-invalid={error !== undefined}
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
        <label>
          Exact instant (ISO 8601 with offset)
          <Input
            aria-invalid={error !== undefined}
            type="text"
            value={literalInputValue(operand.value)}
            onChange={(event) => onCommit(event.currentTarget.value)}
          />
        </label>
        {error && <span role="alert">{error}</span>}
      </fieldset>
    );

  if (semanticType === "money") {
    const current = isRecord(operand.value) ? operand.value : {};
    const amount = typeof current.amount === "string" ? current.amount : "";
    const currency = typeof current.currency === "string" ? current.currency : "";
    return (
      <fieldset>
        <legend>{label}</legend>
        <label>
          Amount
          <Input
            aria-invalid={error !== undefined}
            inputMode="decimal"
            type="text"
            value={amount}
            onChange={(event) => onCommit({ amount: event.currentTarget.value, currency })}
          />
        </label>
        <label>
          Currency
          <Input
            aria-invalid={error !== undefined}
            maxLength={3}
            type="text"
            value={currency}
            onChange={(event) => onCommit({ amount, currency: event.currentTarget.value.toUpperCase() })}
          />
        </label>
        {error && <span role="alert">{error}</span>}
      </fieldset>
    );
  }

  if (semanticType === "text_collection")
    return (
      <label>
        {label} (one item per line)
        <Textarea
          aria-invalid={error !== undefined}
          value={Array.isArray(operand.value) ? operand.value.map(String).join("\n") : ""}
          onChange={(event) => onCommit(event.currentTarget.value.split("\n"))}
        />
        {error && <span role="alert">{error}</span>}
      </label>
    );

  if (semanticType === "opaque_json" || semanticType === "record_reference")
    return (
      <label>
        {label} (JSON value)
        <Textarea
          key={`${pointerForPath(path)}:${JSON.stringify(operand.value)}`}
          aria-invalid={error !== undefined}
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
        {error && <span role="alert">{error}</span>}
      </label>
    );

  return (
    <label>
      {label}
      <Input
        aria-invalid={error !== undefined}
        type="text"
        value={typeof operand.value === "string" ? operand.value : ""}
        onChange={(event) => onCommit(event.currentTarget.value)}
      />
      {error && <span role="alert">{error}</span>}
    </label>
  );
}
