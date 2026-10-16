"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { NativeSelect } from "@vortex/ui/components/native-select";
import { describeFailure } from "@vortex/platform/schema";
import {
  projectStudioFlowTaskSettings,
  type StudioFlowEditResult,
  type StudioFlowSettingCommand,
  type StudioFlowSettingField,
  type StudioFlowSettingValue,
  type StudioFlowTaskOutline,
  type StudioFlowTextContext,
  type StudioSemanticSelection,
} from "@vortex/ui/studio";

type FlowSelection = Extract<StudioSemanticSelection, { kind: "flow" }>;

/** An unapplied change, bound to the draft snapshot it was started from; `null` removes the setting. */
type Edit = Readonly<{ expected: StudioFlowTextContext; value: StudioFlowSettingValue | null }>;

const without = <Value,>(record: Readonly<Record<string, Value>>, key: string): Record<string, Value> =>
  Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

const yesNo = (value: StudioFlowSettingValue | null): string => value === true ? "yes" : value === false ? "no" : "";

function SettingControl({ field, value, disabled, change }: Readonly<{
  field: StudioFlowSettingField;
  value: StudioFlowSettingValue | null;
  disabled: boolean;
  change: (value: StudioFlowSettingValue) => void;
}>) {
  const id = `flow-setting-${field.key}`;
  if (field.control === "yes_no")
    return <NativeSelect id={id} className="w-full" disabled={disabled} value={yesNo(value)}
      onChange={(event) => { if (event.target.value !== "") change(event.target.value === "yes"); }}>
      <option value="" disabled>Choose yes or no</option>
      <option value="yes">Yes</option><option value="no">No</option>
    </NativeSelect>;
  const text = typeof value === "string" ? value : "";
  return <Input id={id} className="w-full" disabled={disabled} value={text}
    type={field.control === "date" ? "date" : "text"}
    inputMode={field.control === "whole_number" ? "numeric" : field.control === "decimal_number" ? "decimal" : undefined}
    placeholder={field.control === "date_time" ? "2026-01-31T09:30:00Z" : undefined}
    onChange={(event) => change(event.target.value)} />;
}

/** The selected task's settings, as a form generated from the task registry's own property declarations. */
export function ApplicationFlowTaskSettings({ context, selection, outline, disabled, onPendingChange, onSetting }: Readonly<{
  context: StudioFlowTextContext;
  selection: FlowSelection;
  outline: StudioFlowTaskOutline;
  disabled: boolean;
  onPendingChange: (pending: boolean) => void;
  onSetting: (expected: StudioFlowTextContext, selection: FlowSelection, command: StudioFlowSettingCommand) => StudioFlowEditResult;
}>) {
  const projection = useMemo(() => projectStudioFlowTaskSettings(context, selection, outline.id, outline.path),
    [context, selection, outline.id, outline.path]);
  const [edits, setEdits] = useState<Readonly<Record<string, Edit>>>({});
  const currentEdits = useRef<Readonly<Record<string, Edit>>>({});
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [status, setStatus] = useState("");

  // The workspace must know about an unapplied edit before React renders, so Save, Reopen and selection changes cannot miss it.
  const changeEdits = (next: Readonly<Record<string, Edit>>) => {
    currentEdits.current = next;
    onPendingChange(Object.keys(next).length > 0);
    setEdits(next);
  };
  useEffect(() => () => onPendingChange(false), [onPendingChange]);

  useEffect(() => {
    if (projection.kind === "unavailable")
      console.error("Flow canvas task settings are unavailable", { flow: selection.flowAlias, task: outline.id },
        projection.cause === undefined ? projection.reason : describeFailure(projection.cause));
  }, [projection, selection.flowAlias, outline.id]);

  if (projection.kind === "unavailable") return <p role="alert" className="text-sm">{projection.reason}</p>;

  const begin = (key: string, value: StudioFlowSettingValue | null) => {
    const previous = currentEdits.current;
    changeEdits({ ...previous, [key]: { expected: previous[key]?.expected ?? context, value } });
    setErrors((previous) => without(previous, key));
    setStatus("");
  };
  const discard = (key: string) => {
    changeEdits(without(currentEdits.current, key));
    setErrors((previous) => without(previous, key));
  };
  const apply = (key: string) => {
    const edit = edits[key];
    if (edit === undefined) return;
    const result = onSetting(edit.expected, selection,
      { kind: "set_task_setting", taskId: outline.id, taskPath: outline.path, property: key, value: edit.value });
    if (result.kind === "applied") {
      discard(key);
      setStatus(`Setting ${key} applied. Save to keep it.`);
    } else setErrors((previous) => ({ ...previous, [key]: result.reason }));
  };

  const { fields } = projection;
  if (fields.length === 0)
    return <p className="text-sm text-muted-foreground">{projection.note ?? "This task has no settings."}</p>;
  return <div className="space-y-3 text-sm">
    {projection.note !== undefined && <p className="text-muted-foreground">{projection.note}</p>}
    {fields.map((field) => {
      const edit = edits[field.key];
      const error = errors[field.key];
      const shown = edit === undefined ? field.value : edit.value;
      const describedBy = error === undefined ? undefined : `flow-setting-${field.key}-error`;
      return <form key={field.key} className="space-y-1"
        onSubmit={(event) => { event.preventDefault(); apply(field.key); }}>
        <label className="block text-muted-foreground" htmlFor={`flow-setting-${field.key}`}>
          {field.label}{field.required ? "" : " (optional)"}</label>
        {field.control === null
          ? <>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted p-2 text-xs">{field.display}</pre>
            {field.note !== undefined && <p className="text-muted-foreground">{field.note}</p>}
          </>
          : <>
            <div aria-describedby={describedBy}>
              {edit !== undefined && edit.value === null
                ? <p className="rounded-md border border-border bg-muted p-2">This setting will be removed.</p>
                : <SettingControl field={field} value={shown} disabled={disabled} change={(value) => begin(field.key, value)} />}
            </div>
            {error !== undefined && <p id={describedBy} role="alert">{error}</p>}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={disabled || edit === undefined}>Apply</Button>
              <Button type="button" variant="outline" size="sm" disabled={disabled || edit === undefined}
                onClick={() => discard(field.key)}>Discard</Button>
              {!field.required && field.value !== null && edit?.value !== null &&
                <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => begin(field.key, null)}>Remove setting</Button>}
            </div>
          </>}
      </form>;
    })}
    <p role="status" aria-live="polite">{status}</p>
  </div>;
}
