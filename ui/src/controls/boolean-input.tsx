import type { ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import { readControlSettings, resolveControlContext } from "./control-context";
import {
  describedBy,
  FieldLabelText,
  FieldMessages,
  inactiveNote,
  useFieldIds,
  useSeededState,
} from "./field-parts";
import { useFormField } from "./form-context";

export type BooleanInputProps = PlatformBlockRenderProps;

/**
 * Checkbox or switch emitting only its declared `field_changed` event with a typed boolean.
 * Both variants are native controls, so Space (and Enter for the switch button) toggles once.
 */
export function BooleanInput(props: BooleanInputProps): ReactElement {
  const context = resolveControlContext(props, "boolean_input", ["field_changed"]);
  const settings = readControlSettings(props, context.location);
  const ids = useFieldIds();
  const fieldKey = settings.fieldKey();
  const label = context.accessibleName ?? props.metadata.name;
  const help = settings.text("help_text");
  const required = settings.boolean("required");
  const variant = settings.choice<"checkbox" | "switch">("variant", "checkbox");
  const disabled = context.inactive || settings.boolean("disabled");
  const error = context.values?.error;
  const note = inactiveNote(context);

  const [checked, setChecked] = useSeededState(context.values?.value ?? false);
  useFormField(fieldKey, props.placementId, checked);

  const change = (next: boolean): void => {
    if (disabled) return;
    setChecked(next);
    context.events?.field_changed?.({ event: "field_changed", fieldKey, value: next });
  };

  const described = describedBy(ids, help, error, note);
  return (
    <div
      data-vortex-control="boolean-input"
      data-vortex-placement-id={props.placementId}
      data-vortex-field-key={fieldKey}
      data-vortex-variant={variant}
      className="vortex-field vortex-field-inline"
    >
      {variant === "switch" ? (
        <button
          id={ids.control}
          type="button"
          role="switch"
          aria-checked={checked}
          aria-labelledby={ids.label}
          aria-invalid={error !== undefined}
          {...described}
          disabled={disabled}
          onClick={() => change(!checked)}
          className="vortex-switch"
        >
          <span aria-hidden="true" className="vortex-switch-thumb" />
        </button>
      ) : (
        <input
          id={ids.control}
          type="checkbox"
          name={fieldKey}
          checked={checked}
          onChange={(event) => change(event.target.checked)}
          disabled={disabled}
          required={required}
          aria-invalid={error !== undefined}
          {...described}
          className="vortex-checkbox"
        />
      )}
      <label id={ids.label} htmlFor={ids.control} className="vortex-field-label">
        <FieldLabelText label={label} required={required} />
      </label>
      <FieldMessages ids={ids} help={help} error={error} note={note} />
    </div>
  );
}
