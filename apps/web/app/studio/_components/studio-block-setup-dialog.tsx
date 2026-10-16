"use client";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@vortex/ui/components/dialog";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import type {
  StudioCompositionAddSettings, StudioCompositionAddTarget, StudioPaletteChoice, StudioSourceQuery,
} from "@vortex/ui/studio";

/** A new block whose required settings or query the person gives before it is added. */
export type StudioBlockSetupRequest = Readonly<{
  choice: StudioPaletteChoice;
  target: StudioCompositionAddTarget;
  /** The query the page itself reads, offered first for a data block. */
  pageQuery: string | undefined;
  add: (settings: StudioCompositionAddSettings, query: string | null) => string | true;
}>;

type Inputs = Readonly<Record<string, string | boolean>>;

/**
 * Sets up a new block before it is added: the query a data block reads, and each required setting
 * its catalogue release has no default for. Every other setting takes its catalogue default.
 */
export function StudioBlockSetupDialog({ request, queries, onClose }: Readonly<{
  request: StudioBlockSetupRequest | null;
  queries: readonly StudioSourceQuery[];
  onClose: () => void;
}>) {
  const [query, setQuery] = useState("");
  const [inputs, setInputs] = useState<Inputs>({});
  const [problem, setProblem] = useState("");
  const formId = useId();
  useEffect(() => {
    setInputs({});
    setProblem("");
    setQuery(request?.choice.needsQuery !== true ? ""
      : queries.some((candidate) => candidate.reference === request.pageQuery) ? request.pageQuery!
        : queries[0]?.reference ?? "");
  }, [request, queries]);
  const fields = useMemo(() => {
    const chosen = queries.find((candidate) => candidate.reference === query);
    if (chosen !== undefined) return chosen.fields;
    const all = new Map(queries.flatMap((candidate) => candidate.fields).map((field) => [field.reference, field]));
    return [...all.values()];
  }, [queries, query]);
  if (request === null) return null;
  const { choice, target } = request;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const settings: Record<string, StudioCompositionAddSettings[string]> = {};
    for (const field of choice.setup) {
      const value = inputs[field.key];
      if (field.kind === "boolean") settings[field.key] = { kind: "boolean", value: value === true };
      else if (field.kind === "number") {
        const number = Number(value);
        if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(number)) {
          setProblem(`Enter a number for ${field.label}.`);
          return;
        }
        settings[field.key] = { kind: "number", value: number };
      } else {
        if (typeof value !== "string" || value === "") {
          setProblem(`Give ${field.label} a value.`);
          return;
        }
        settings[field.key] = { kind: field.kind, value } as StudioCompositionAddSettings[string];
      }
    }
    if (choice.needsQuery && query === "") {
      setProblem("Choose the data this block shows.");
      return;
    }
    const outcome = request.add(settings, choice.needsQuery ? query : null);
    if (outcome === true) onClose();
    else setProblem(outcome);
  };
  const set = (key: string, value: string | boolean) => { setInputs({ ...inputs, [key]: value }); setProblem(""); };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set up {choice.name}</DialogTitle>
          <DialogDescription>
            It goes into {target.label}. Every other setting starts with its default; change them in the inspector.
          </DialogDescription>
        </DialogHeader>
        <form id={formId} className="space-y-3" onSubmit={submit}>
          {choice.needsQuery && <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-query`}>Data</Label>
            {queries.length === 0
              ? <p role="status" className="text-sm">This application has no query of its own yet. Add one to a module first.</p>
              : <NativeSelect id={`${formId}-query`} className="w-full" value={query}
                  onChange={(event) => { setQuery(event.target.value); setInputs({}); setProblem(""); }}>
                  {queries.map((candidate) => <NativeSelectOption key={candidate.reference} value={candidate.reference}>
                    {candidate.label}</NativeSelectOption>)}
                </NativeSelect>}
          </div>}
          {choice.setup.map((field) => {
            const id = `${formId}-${field.key}`;
            const value = inputs[field.key];
            return <div key={field.key} className="flex flex-col gap-1.5">
              {field.kind === "boolean"
                ? <label className="flex items-center gap-2 text-sm"><Checkbox checked={value === true}
                    onCheckedChange={(checked) => set(field.key, checked)} />{field.label}</label>
                : <Label htmlFor={id}>{field.label}</Label>}
              {field.kind === "text" && <Input id={id} required minLength={field.minLength} maxLength={field.maxLength}
                value={typeof value === "string" ? value : ""} onChange={(event) => set(field.key, event.target.value)} />}
              {field.kind === "number" && <Input id={id} type="number" required step={field.integer ? 1 : "any"}
                min={field.minimum} max={field.maximum}
                value={typeof value === "string" ? value : ""} onChange={(event) => set(field.key, event.target.value)} />}
              {(field.kind === "choice" || field.kind === "field_reference") &&
                <NativeSelect id={id} className="w-full" required value={typeof value === "string" ? value : ""}
                  onChange={(event) => set(field.key, event.target.value)}>
                  <NativeSelectOption value="">Choose…</NativeSelectOption>
                  {(field.kind === "choice"
                    ? field.options.map((option) => ({ value: option.key, label: option.label }))
                    : fields.map((option) => ({ value: option.reference, label: option.label })))
                    .map((option) => <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>)}
                </NativeSelect>}
              {field.help === undefined ? null : <p className="text-xs text-muted-foreground">{field.help}</p>}
            </div>;
          })}
          {problem.length === 0 ? null : <p role="alert" className="text-sm text-destructive">{problem}</p>}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" form={formId}>Add {choice.name}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
