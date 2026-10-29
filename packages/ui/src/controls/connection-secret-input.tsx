"use client";

import { useRef, useState, type ReactElement } from "react";
import { Button } from "../components/button";
import { Field, FieldLabel } from "../components/field";
import { Input } from "../components/input";
import {
  readControlSettings,
  resolveControlContext,
  type ControlRenderProps,
} from "./control-context";
import {
  describedBy,
  FieldLabelText,
  FieldMessages,
  inactiveNote,
  useFieldFeedback,
  useFieldIds,
} from "./field-parts";
import { useFormField, useFormFieldError } from "./form-context";

/** The form sees only the one-use reference returned by the write-only endpoint. */
export function ConnectionSecretInput(props: ControlRenderProps<never>): ReactElement {
  const context = resolveControlContext(props, ["field_changed"]);
  const settings = readControlSettings(props, context.location);
  const ids = useFieldIds();
  const fieldKey = settings.fieldKey();
  const label = context.accessibleName ?? props.metadata.name;
  const required = settings.boolean("required");
  const readOnly = settings.boolean("read_only");
  const feedback = useFieldFeedback(fieldKey);
  const disabled = context.inactive || settings.boolean("disabled") || feedback?.disabled === true;
  const input = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [reference, setReference] = useState<string | null>(null);
  const [failure, setFailure] = useState<string>();
  useFormField(fieldKey, props.placementId, reference, () =>
    busyRef.current
      ? "Wait for the secret to be stored."
      : (failure ??
        (required && !disabled && !readOnly && reference === null
          ? `${label} is required.`
          : undefined)),
  );
  const formError = useFormFieldError(fieldKey);
  const help = settings.text("help_text");
  const note = inactiveNote(context);
  const error = failure ?? formError;

  const store = async () => {
    if (busyRef.current || disabled || readOnly || input.current === null) return;
    const value = input.current.value;
    input.current.value = "";
    if (value.length === 0 || value.length > 8192) {
      setFailure("Enter a secret of at most 8192 characters.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setFailure(undefined);
    setReference(null);
    context.events?.field_changed?.({ event: "field_changed", fieldKey, value: null });
    try {
      const response = await fetch("/api/connection-secrets", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: value }),
      });
      const result: unknown = await response.json();
      if (
        !response.ok ||
        typeof result !== "object" ||
        result === null ||
        !("reference" in result) ||
        typeof result.reference !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.reference)
      )
        throw new Error("secret_not_stored");
      setReference(result.reference);
      context.events?.field_changed?.({
        event: "field_changed",
        fieldKey,
        value: result.reference,
      });
    } catch {
      setFailure("The secret could not be stored. Enter it again to retry.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Field
      data-vortex-control="connection-secret-input"
      data-vortex-field-key={fieldKey}
      hidden={feedback?.hidden === true}
    >
      <FieldLabel htmlFor={ids.control}>
        <FieldLabelText label={label} required={required} />
      </FieldLabel>
      <div className="flex items-center gap-3">
        <Input
          ref={input}
          id={ids.control}
          type="password"
          autoComplete="new-password"
          disabled={disabled || readOnly || busy}
          aria-invalid={error !== undefined}
          {...describedBy(ids, help, error, note, feedback)}
        />
        <Button
          type="button"
          variant="outline"
          disabled={disabled || readOnly || busy}
          onClick={() => {
            void store();
          }}
        >
          Set secret
        </Button>
        {reference !== null ? <span>Set</span> : null}
      </div>
      {busy ? <p role="status">Storing…</p> : null}
      <FieldMessages ids={ids} help={help} error={error} note={note} draftFeedback={feedback} />
    </Field>
  );
}
