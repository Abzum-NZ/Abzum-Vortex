"use client";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { Button } from "@vortex/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vortex/ui/components/dialog";
import {
  StudioQueryPicker,
  StudioSettingFields,
  StudioOptionControl,
  studioBlockChoices,
  studioSettingProblems,
  studioBoardPipelines,
  type StudioCompositionAddTarget,
  type StudioCompositionSettings,
  type StudioPaletteChoice,
  type StudioSettingChoices,
} from "@vortex/ui/studio";
import {
  plainSettingValue,
  typedSourceSettingValue,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import { Label } from "@vortex/ui/components/label";

/** A new block whose required settings or query the person gives before it is added. */
export type StudioBlockSetupRequest = Readonly<{
  choice: StudioPaletteChoice;
  target: StudioCompositionAddTarget;
  /** The query the page itself reads, offered first for a data block. */
  pageQuery: string | undefined;
  add: (settings: StudioCompositionSettings, query: string | null) => string | true;
}>;

const setupDefaults = (choice: StudioPaletteChoice | undefined): StudioCompositionSettings =>
  Object.fromEntries(
    (choice?.setup ?? []).flatMap((property) => {
      if (property.defaultValue === undefined) return [];
      const value = typedSourceSettingValue(
        plainSettingValue(property.defaultValue),
        property,
        [property.key],
        [],
      );
      if (value === undefined) throw new Error(`Invalid setup default for ${property.label}`);
      return [[property.key, value]];
    }),
  );

/**
 * Sets up a new block before it is added: the query a data block reads, and each required setting
 * its catalogue release has no default for, drawn with the same typed controls as the inspector.
 * Every other setting takes its catalogue default.
 */
export function StudioBlockSetupDialog({
  request,
  source,
  choices: draftChoices,
  onClose,
}: Readonly<{
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
  const pipelineSetup =
    request?.choice.studioSetup?.kind === "pipeline" ? request.choice.studioSetup : undefined;
  const pipelines = useMemo(
    () => (pipelineSetup === undefined ? [] : studioBoardPipelines(source, pipelineSetup)),
    [source, pipelineSetup],
  );
  const stage = pipelineSetup === undefined ? undefined : values[pipelineSetup.fieldProperty];
  const pipeline =
    stage?.kind === "field_reference"
      ? pipelines.find((candidate) => candidate.reference === stage.field)
      : undefined;
  const pipelineUnset =
    pipelineSetup === undefined
      ? "Choose a pipeline"
      : pipelines.length === 0
        ? pipelineSetup.emptyLabel
        : pipelines.every((candidate) => !candidate.selectable)
          ? pipelineSetup.stageFilterError
          : "Choose a pipeline";
  useEffect(() => {
    setValues(setupDefaults(request?.choice));
    setProblem("");
    setQuery(
      request?.choice.needsQuery !== true
        ? ""
        : queries.some((candidate) => candidate.reference === request.pageQuery)
          ? request.pageQuery!
          : (queries[0]?.reference ?? ""),
    );
  }, [request, queries]);
  // A block without a query picks any field of the draft; one with a query, only that query's fields.
  const choices = useMemo(
    () =>
      pipelineSetup === undefined
        ? studioBlockChoices(draftChoices, query === "" ? null : query)
        : { ...draftChoices, fields: pipeline?.fields ?? [] },
    [draftChoices, query, pipelineSetup, pipeline],
  );
  if (request === null) return null;
  const { choice, target } = request;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pipelineSetup !== undefined && pipeline?.selectable !== true) {
      setProblem(pipeline?.unavailableReason ?? pipelineUnset);
      return;
    }
    if (pipelineSetup === undefined && choice.needsQuery && query === "") {
      setProblem("Choose the data this block shows.");
      return;
    }
    const problems = studioSettingProblems(values, choice.setup, choices);
    if (problems.length > 0) {
      setProblem(problems.join(" "));
      return;
    }
    const outcome = request.add(
      values,
      pipelineSetup === undefined && choice.needsQuery ? query : null,
    );
    if (outcome === true) onClose();
    else setProblem(outcome);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-dvh overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Set up {choice.name}</DialogTitle>
          <DialogDescription>
            Add to {target.label}. You can change its settings in the inspector.
          </DialogDescription>
        </DialogHeader>
        <form id={formId} className="space-y-4" onSubmit={submit}>
          {pipelineSetup !== undefined ? (
            <div className="space-y-2">
              <Label htmlFor={`${formId}-pipeline`}>{pipelineSetup.label}</Label>
              <StudioOptionControl
                id={`${formId}-pipeline`}
                disabled={false}
                value={pipeline?.reference ?? ""}
                unset={pipelineUnset}
                options={pipelines.map((entry) => ({
                  value: entry.reference,
                  label: entry.selectable
                    ? entry.label
                    : `${entry.label} (${entry.unavailableReason})`,
                  disabled: !entry.selectable,
                }))}
                onChange={(next) => {
                  const chosen = pipelines.find((entry) => entry.reference === next);
                  setValues(
                    chosen?.selectable !== true || chosen.titleField === undefined
                      ? {}
                      : {
                          [pipelineSetup.fieldProperty]: {
                            kind: "field_reference",
                            field: chosen.reference,
                          },
                          [pipelineSetup.titleFieldProperty]: {
                            kind: "field_reference",
                            field: chosen.titleField,
                          },
                        },
                  );
                  setProblem("");
                }}
              />
              <p className="text-sm text-muted-foreground">{pipelineSetup.help}</p>
            </div>
          ) : (
            choice.needsQuery && (
              <StudioQueryPicker
                id={`${formId}-query`}
                queries={queries}
                value={query}
                disabled={false}
                onChange={(next) => {
                  setQuery(next);
                  setValues(setupDefaults(choice));
                  setProblem("");
                }}
              />
            )
          )}
          <StudioSettingFields
            idPrefix={formId}
            properties={
              pipelineSetup === undefined
                ? choice.setup
                : choice.setup.filter((property) => property.key !== pipelineSetup.fieldProperty)
            }
            values={values}
            choices={choices}
            disabled={pipelineSetup !== undefined && pipeline?.selectable !== true}
            onChange={(next) => {
              setValues(next);
              setProblem("");
            }}
          />
          {problem.length === 0 ? null : (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={pipelineSetup !== undefined && pipeline?.selectable !== true}
          >
            Add {choice.name}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
