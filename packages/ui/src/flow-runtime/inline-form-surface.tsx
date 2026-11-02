"use client";

import { useState, type ReactElement } from "react";
import { Button } from "../components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "../components/field";
import { Input } from "../components/input";
import { Textarea } from "../components/textarea";
import type { FlowInlineFormIntent } from "./intents";

/**
 * The fields a Show form step declares itself, in the dialog the flow host draws. A field the step
 * expects an exact text in (the name of the application to remove) keeps Submit off, and says why,
 * until it matches; the server still proves every answer.
 */
export function InlineFormFields({
  form,
  onSubmit,
  onCancel,
}: Readonly<{
  form: FlowInlineFormIntent;
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
}>): ReactElement {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(form.fields.map((field) => [field.name, form.inputs[field.name] ?? ""])),
  );
  const problems = form.fields.flatMap((field) => {
    const value = (values[field.name] ?? "").trim();
    const expected = form.expect[field.name];
    if (expected !== undefined && value !== expected)
      return [{ name: field.name, text: `Type ${expected} exactly to confirm.` }];
    if (field.required && value === "")
      return [{ name: field.name, text: `${field.label} is required.` }];
    return [];
  });
  // A required field is only called out once the person has typed in it; a text it must equal
  // always says what to type.
  const [typedIn, setTypedIn] = useState<ReadonlySet<string>>(new Set());
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (problems.length === 0)
          onSubmit(
            Object.fromEntries(form.fields.map((field) => [field.name, values[field.name] ?? ""])),
          );
      }}
    >
      {form.message === undefined ? null : (
        <p className="text-sm text-muted-foreground">{form.message}</p>
      )}
      <FieldGroup>
        {form.fields.map((field) => {
          const problem = problems.find((entry) => entry.name === field.name);
          const id = `inline-form-${form.taskId}-${field.name}`;
          const expects = form.expect[field.name] !== undefined;
          const shown = problem !== undefined && (expects || typedIn.has(field.name));
          const invalid = shown && typedIn.has(field.name);
          const Control = field.multiline ? Textarea : Input;
          return (
            <Field key={field.name} data-invalid={invalid ? true : undefined}>
              <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
              <Control
                id={id}
                name={field.name}
                value={values[field.name] ?? ""}
                aria-invalid={invalid ? true : undefined}
                aria-describedby={shown ? `${id}-hint` : undefined}
                onChange={(event) => {
                  const next = event.target.value;
                  setValues((held) => ({ ...held, [field.name]: next }));
                  setTypedIn((held) => new Set(held).add(field.name));
                }}
              />
              {problem === undefined || !shown ? null : (
                <FieldDescription id={`${id}-hint`}>{problem.text}</FieldDescription>
              )}
            </Field>
          );
        })}
      </FieldGroup>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={problems.length > 0}>
          {form.submitLabel ?? "Submit"}
        </Button>
      </div>
    </form>
  );
}
