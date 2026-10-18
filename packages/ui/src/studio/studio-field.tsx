"use client";
import { useId, type ReactNode } from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "../components/field";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { Button } from "../components/button";
import { Info } from "lucide-react";

/** Long help is available on focus and remains the control's accessible description. */
export function StudioHelp({ hint, id }: Readonly<{ hint: string; id?: string }>) {
  const generated = useId();
  const descriptionId = id ?? generated;
  return hint.length <= 80 ? (
    <FieldDescription id={descriptionId} className="text-sm">
      {hint}
    </FieldDescription>
  ) : (
    <>
      <span id={descriptionId} className="sr-only">
        {hint}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="More information"
              aria-describedby={descriptionId}
            />
          }
        >
          <Info className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent className="max-w-prose">{hint}</TooltipContent>
      </Tooltip>
    </>
  );
}

export function StudioField({
  label,
  hint,
  error,
  optional = false,
  children,
}: Readonly<{
  label: ReactNode;
  hint?: string | undefined;
  error?: string | undefined;
  optional?: boolean;
  children: (
    control: Readonly<{ id: string; "aria-invalid"?: true; "aria-describedby"?: string }>,
  ) => ReactNode;
}>) {
  const id = useId();
  const description = [
    hint === undefined ? undefined : id + "-hint",
    error === undefined ? undefined : id + "-error",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Field data-invalid={error === undefined ? undefined : true}>
      <div className="flex items-center gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {optional && <span className="text-xs text-muted-foreground">Optional</span>}
        {hint !== undefined && hint.length > 80 && <StudioHelp hint={hint} id={id + "-hint"} />}
      </div>
      {children({
        id,
        ...(error === undefined ? {} : { "aria-invalid": true as const }),
        ...(description === "" ? {} : { "aria-describedby": description }),
      })}
      {hint !== undefined && hint.length <= 80 && <StudioHelp hint={hint} id={id + "-hint"} />}
      {error !== undefined && <FieldError id={id + "-error"}>{error}</FieldError>}
    </Field>
  );
}
