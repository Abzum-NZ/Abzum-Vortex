"use client";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { Button } from "@vortex/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@vortex/ui/components/dialog";
import {
  StudioQueryPicker, StudioSettingFields, StudioOptionControl, studioBlockChoices, studioSettingProblems,
  boardBlockKey, studioBoardPipelines,
  type StudioCompositionAddTarget, type StudioCompositionSettings, type StudioPaletteChoice,
  type StudioSettingChoices,
} from "@vortex/ui/studio";
import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import { Label } from "@vortex/ui/components/label";


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
export function StudioBlockSetupDialog({ request, source, choices: draftChoices, onClose }: Readonly<{
  request: StudioBlockSetupRequest | null;
  source: ApplicationSourceDocument;
  /** What reference settings can point at, read from the draft being edited. */
  choices: StudioSettingChoices;
  onClose: () => void;
}>) {
  const queries = draftChoices.queries;
  const [query, setQuery] = useState("");
  const [values, setValues] = useState<StudioCompositionSettings>({});
  const [problem, setProblem] = useState("");
  const formId = useId();
  const isBoard = request?.choice.key === boardBlockKey;
  const pipelines = useMemo(() => studioBoardPipelines(source), [source]);
  const stage = values.choice_field;
  const pipeline = stage?.kind === "field_reference"
    ? pipelines.find((candidate) => candidate.reference === stage.field) : undefined;
  useEffect(() => {
    setValues({});
    setProblem("");
    setQuery(request?.choice.needsQuery !== true ? ""
      : queries.some((candidate) => candidate.reference === request.pageQuery) ? request.pageQuery!
        : queries[0]?.reference ?? "");
  }, [request, queries]);
  // A block without a query picks any field of the draft; one with a query, only that query's fields.
  const choices = useMemo(() => isBoard ? { ...draftChoices, fields: pipeline?.fields ?? [] }
    : studioBlockChoices(draftChoices, query === "" ? null : query), [draftChoices, query, isBoard, pipeline]);
  if (request === null) return null;
  const { choice, target } = request;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isBoard && pipeline === undefined) {
      setProblem("Choose a pipeline. Create one on the record type in Data if it has none yet.");
      return;
    }
    if (!isBoard && choice.needsQuery && query === "") {
      setProblem("Choose the data this block shows.");
      return;
    }
    const problems = studioSettingProblems(values, choice.setup);
    if (problems.length > 0) {
      setProblem(problems.join(" "));
      return;
    }
    const outcome = request.add(values, !isBoard && choice.needsQuery ? query : null);
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
          {isBoard ? <div className="space-y-2">
            <Label htmlFor={`${formId}-pipeline`}>Pipeline</Label>
            <StudioOptionControl id={`${formId}-pipeline`} disabled={false} value={pipeline?.reference ?? ""}
              unset={pipelines.length === 0 ? "Create a pipeline in Data first" : "Choose a pipeline"}
              options={pipelines.map((entry) => ({ value: entry.reference, label: entry.label }))}
              onChange={(next) => {
                const chosen = pipelines.find((entry) => entry.reference === next);
                setValues(chosen === undefined ? {} : {
                  choice_field: { kind: "field_reference", field: chosen.reference },
                  card_title_field: { kind: "field_reference", field: chosen.titleField },
                });
                setProblem("");
              }} />
            <p className="text-sm text-muted-foreground">Shows every record by stage. Cards follow the pipeline's allowed moves and permissions.</p>
          </div> : choice.needsQuery && <StudioQueryPicker id={`${formId}-query`} queries={queries} value={query} disabled={false}
            onChange={(next) => { setQuery(next); setValues({}); setProblem(""); }} />}
          <StudioSettingFields idPrefix={formId} properties={isBoard ? choice.setup
            .filter((property) => property.key !== "choice_field")
            .map((property) => property.key === "card_title_field"
              ? { ...property, help: "The field shown as each card's title." } : property) : choice.setup}
            values={values} choices={choices} disabled={isBoard && pipeline === undefined}
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
