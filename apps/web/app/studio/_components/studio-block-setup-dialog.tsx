"use client";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { Button } from "@vortex/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@vortex/ui/components/dialog";
import {
  StudioQueryPicker, StudioSettingFields, studioSettingProblems,
  type StudioCompositionAddTarget, type StudioCompositionSettings, type StudioPaletteChoice,
  type StudioQueryChoice, type StudioSettingChoices,
} from "@vortex/ui/studio";


/** A new block whose required settings or query the person gives before it is added. */
export type StudioBlockSetupRequest = Readonly<{
  choice: StudioPaletteChoice;
  target: StudioCompositionAddTarget;
  /** The query the page itself reads, offered first for a data block. */
  pageQuery: string | undefined;
  add: (settings: StudioCompositionSettings, query: string | null) => string | true;
}>;

/**
 * Sets up a new block before it is added: the query a data block reads, and each required setting
 * its catalogue release has no default for, drawn with the same typed controls as the inspector.
 * Every other setting takes its catalogue default.
 */
export function StudioBlockSetupDialog({ request, queries, pages, onClose }: Readonly<{
  request: StudioBlockSetupRequest | null;
  queries: readonly StudioQueryChoice[];
  pages: StudioSettingChoices["pages"];
  onClose: () => void;
}>) {
  const [query, setQuery] = useState("");
  const [values, setValues] = useState<StudioCompositionSettings>({});
  const [problem, setProblem] = useState("");
  const formId = useId();
  useEffect(() => {
    setValues({});
    setProblem("");
    setQuery(request?.choice.needsQuery !== true ? ""
      : queries.some((candidate) => candidate.reference === request.pageQuery) ? request.pageQuery!
        : queries[0]?.reference ?? "");
  }, [request, queries]);
  const choices = useMemo((): StudioSettingChoices => {
    const chosen = queries.find((candidate) => candidate.reference === query);
    const fields = chosen !== undefined ? chosen.fields
      : [...new Map(queries.flatMap((candidate) => candidate.fields).map((field) => [field.reference, field])).values()];
    return { fields, queries, pages };
  }, [queries, query, pages]);
  if (request === null) return null;
  const { choice, target } = request;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (choice.needsQuery && query === "") {
      setProblem("Choose the data this block shows.");
      return;
    }
    const problems = studioSettingProblems(values, choice.setup);
    if (problems.length > 0) {
      setProblem(problems.join(" "));
      return;
    }
    const outcome = request.add(values, choice.needsQuery ? query : null);
    if (outcome === true) onClose();
    else setProblem(outcome);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Set up {choice.name}</DialogTitle>
          <DialogDescription>
            It goes into {target.label}. Every other setting starts with its default; change them in the inspector.
          </DialogDescription>
        </DialogHeader>
        <form id={formId} className="space-y-3" onSubmit={submit}>
          {choice.needsQuery && <StudioQueryPicker id={`${formId}-query`} queries={queries} value={query} disabled={false}
            onChange={(next) => { setQuery(next); setValues({}); setProblem(""); }} />}
          <StudioSettingFields idPrefix={formId} properties={choice.setup} values={values} choices={choices} disabled={false}
            onChange={(next) => { setValues(next); setProblem(""); }} />
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
