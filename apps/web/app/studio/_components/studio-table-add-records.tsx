"use client";
import { StudioOptionControl } from "@vortex/ui/studio";
import { Switch } from "@vortex/ui/components/switch";
import { StudioField } from "./studio-field";

/**
 * The two settings one Records table needs to add records from its list: the form page a new record
 * opens, and the switch that shows the Add button. The form comes first because the button has
 * nothing to open without it, and the switch stays off until a form is chosen, so the draft never
 * holds a table that cannot be read. Clearing the form clears the switch in the same edit, and a
 * form the application no longer has reads as none, so the table draws without the Add button.
 */
export function StudioTableAddRecords({
  form,
  adding,
  pages,
  disabled,
  onChange,
}: Readonly<{
  /** The create form page the draft names, or "" for none. */
  form: string;
  adding: boolean;
  pages: readonly Readonly<{ key: string; label: string }>[];
  disabled: boolean;
  onChange: (next: Readonly<{ form: string; adding: boolean }>) => void;
}>) {
  const missing = form !== "" && !pages.some((page) => page.key === form);
  const current = missing ? "" : form;
  return (
    <>
      <StudioField
        label="Create form page"
        hint={
          missing
            ? "The form this list added records with is no longer in the application. Choose one, or leave it empty."
            : "The form a new record opens when this list adds records."
        }
      >
        {(control) => (
          <StudioOptionControl
            {...control}
            value={current}
            unset="No create form"
            options={pages.map((page) => ({ value: page.key, label: page.label }))}
            disabled={disabled}
            onChange={(next) => onChange({ form: next, adding: next === "" ? false : adding })}
          />
        )}
      </StudioField>
      <StudioField
        label="Add records from this list"
        hint={
          current === ""
            ? "Choose a create form page first; the list's Add button opens it."
            : "Shows a create button in the list header and in its empty state."
        }
      >
        {(control) => (
          <Switch
            {...control}
            checked={current === "" ? false : adding}
            disabled={disabled || current === ""}
            onCheckedChange={(checked) => onChange({ form: current, adding: checked === true })}
          />
        )}
      </StudioField>
    </>
  );
}
