"use client";

import { useId, type ReactElement, type ReactNode } from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "@vortex/ui/components/field";

/** Accessibility attributes a Studio control must carry so its label, hint and error are linked. */
type StudioControlProps = Readonly<{
  id: string;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
}>;

/**
 * The one Studio form field: a shadcn Field whose label is linked to the control by `htmlFor`,
 * whose hint and located error are referenced through `aria-describedby`, and whose control is
 * marked `aria-invalid` while an error is shown. The error text is the refusal's real reason.
 */
export function StudioField({ label, hint, error, children }: Readonly<{
  label: ReactNode;
  hint?: string | undefined;
  error?: string | undefined;
  children: (control: StudioControlProps) => ReactNode;
}>): ReactElement {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const references = [hint === undefined ? undefined : hintId, error === undefined ? undefined : errorId]
    .filter((reference): reference is string => reference !== undefined);
  return (
    <Field data-invalid={error === undefined ? undefined : true}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children({
        id,
        ...(error === undefined ? {} : { "aria-invalid": true as const }),
        ...(references.length === 0 ? {} : { "aria-describedby": references.join(" ") }),
      })}
      {hint === undefined ? null : <FieldDescription id={hintId}>{hint}</FieldDescription>}
      {error === undefined ? null : <FieldError id={errorId}>{error}</FieldError>}
    </Field>
  );
}
