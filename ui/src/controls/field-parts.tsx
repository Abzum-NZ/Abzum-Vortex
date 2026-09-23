import { useId, useState, type ReactElement } from "react";
import type { ControlContext } from "./control-context";
import type { ProjectedControlValueKind } from "./projected-data";

/** Element identities for one field and the descriptions its control references. */
export type FieldIds = Readonly<{
  control: string;
  label: string;
  help: string;
  error: string;
  note: string;
}>;

export function useFieldIds(): FieldIds {
  const id = useId();
  return {
    control: `${id}-control`,
    label: `${id}-label`,
    help: `${id}-help`,
    error: `${id}-error`,
    note: `${id}-note`,
  };
}

/**
 * Local edit state seeded from the projected value. A changed projection (a loaded draft or a
 * reset) replaces local edits; otherwise the person's edits stay responsive between projections.
 */
export function useSeededState<Value>(seed: Value): [Value, (next: Value) => void] {
  const [state, setState] = useState(seed);
  const [previousSeed, setPreviousSeed] = useState(seed);
  if (!Object.is(seed, previousSeed)) {
    setPreviousSeed(seed);
    setState(seed);
  }
  return [state, setState];
}

/** Fixed data-free note for a field that cannot currently be used. */
export const inactiveNote = <Kind extends ProjectedControlValueKind>(
  context: ControlContext<Kind>,
): string | undefined =>
  context.unavailable ? "Unavailable" : context.disabledReason;

/** Space-separated description references for the field's control. */
export const describedBy = (
  ids: FieldIds,
  help: string | undefined,
  error: string | undefined,
  note: string | undefined,
): Readonly<{ "aria-describedby"?: string }> => {
  const references = [
    help === undefined ? undefined : ids.help,
    error === undefined ? undefined : ids.error,
    note === undefined ? undefined : ids.note,
  ].filter((reference): reference is string => reference !== undefined);
  return references.length === 0 ? {} : { "aria-describedby": references.join(" ") };
};

/** Visible label text with a required marker hidden from assistive technology. */
export function FieldLabelText({
  label,
  required,
}: Readonly<{ label: string; required: boolean }>): ReactElement {
  return (
    <>
      {label}
      {required ? (
        <span aria-hidden="true" className="vortex-field-required">
          {" *"}
        </span>
      ) : null}
    </>
  );
}

/** Help, error and unavailable descriptions referenced by the field's control. */
export function FieldMessages({
  ids,
  help,
  error,
  note,
}: Readonly<{
  ids: FieldIds;
  help: string | undefined;
  error: string | undefined;
  note: string | undefined;
}>): ReactElement {
  return (
    <>
      {help === undefined ? null : (
        <span id={ids.help} className="vortex-field-help">
          {help}
        </span>
      )}
      {error === undefined ? null : (
        <span id={ids.error} role="alert" className="vortex-field-error">
          {error}
        </span>
      )}
      {note === undefined ? null : (
        <span id={ids.note} className="vortex-field-note">
          {note}
        </span>
      )}
    </>
  );
}
