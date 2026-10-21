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
  STUDIO_GROUPED_TABLE_PRESET,
  StudioQueryPicker,
  StudioSettingFields,
  studioBlockChoices,
  studioGroupedTableSettings,
  studioGroupedTableStart,
  studioSettingProblems,
  studioTablePresetProperty,
  type StudioCompositionAddTarget,
  type StudioCompositionSettings,
  type StudioPaletteChoice,
  type StudioSettingChoices,
} from "@vortex/ui/studio";

import { plainSettingValue, typedSourceSettingValue } from "@vortex/platform/schema";

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
  choices: draftChoices,
  onClose,
}: Readonly<{
  request: StudioBlockSetupRequest | null;
  /** What reference settings can point at, read from the draft being edited. */
  choices: StudioSettingChoices;
  onClose: () => void;
}>) {
  const queries = draftChoices.queries;
  const [query, setQuery] = useState("");
  const [values, setValues] = useState<StudioCompositionSettings>({});
  // The Grouped table preset: the field it groups by and, for a date, the calendar unit.
  const [grouped, setGrouped] = useState(false);
  const [groupValues, setGroupValues] = useState<StudioCompositionSettings>({});
  const [problem, setProblem] = useState("");
  const formId = useId();
  useEffect(() => {
    setValues(setupDefaults(request?.choice));
    setGrouped(false);
    setGroupValues({});
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
    () => studioBlockChoices(draftChoices, query === "" ? null : query),
    [draftChoices, query],
  );
  // The bound query starts the Grouped table with the field it already groups by.
  const queryChoice = queries.find((candidate) => candidate.reference === query);
  const choosePreset = (next: StudioCompositionSettings) => {
    const preset = next["presentation"];
    const groupedPreset = preset?.kind === "choice" && preset.value === STUDIO_GROUPED_TABLE_PRESET;
    // Switching to Grouped table starts it as the query groups; other edits keep the chosen field.
    if (groupedPreset && !grouped) setGroupValues(studioGroupedTableStart(queryChoice));
    setGrouped(groupedPreset);
    setValues(groupedPreset ? { ...next, presentation: { kind: "choice", value: "grid" } } : next);
  };
  if (request === null) return null;
  const { choice, target } = request;
  const groupedTable = choice.groupedTable;
  // Table, List and Grouped table are one Preset choice; the first two are catalogue values and
  // the third is a palette choice that switches Group by on.
  const setup =
    groupedTable === undefined
      ? choice.setup
      : choice.setup.map((property) =>
          property.key === "presentation" ? studioTablePresetProperty(property) : property,
        );
  const shown: StudioCompositionSettings = grouped
    ? { ...values, presentation: { kind: "choice", value: STUDIO_GROUPED_TABLE_PRESET } }
    : values;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (choice.needsQuery && query === "") {
      setProblem("Choose the data this block shows.");
      return;
    }
    const problems = studioSettingProblems(values, choice.setup, choices);
    if (problems.length > 0) {
      setProblem(problems.join(" "));
      return;
    }
    let added = values;
    if (grouped && groupedTable !== undefined) {
      const preset = studioGroupedTableSettings(groupedTable, queryChoice, groupValues);
      if ("problem" in preset) {
        setProblem(preset.problem);
        return;
      }
      added = { ...values, ...preset.settings };
    }
    const outcome = request.add(added, choice.needsQuery ? query : null);
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
          {choice.needsQuery && (
            <StudioQueryPicker
              id={`${formId}-query`}
              queries={queries}
              value={query}
              disabled={false}
              onChange={(next) => {
                setQuery(next);
                setValues(setupDefaults(choice));
                setGrouped(false);
                setGroupValues({});
                setProblem("");
              }}
            />
          )}
          <StudioSettingFields
            idPrefix={formId}
            properties={setup}
            values={shown}
            choices={choices}
            disabled={false}
            onChange={(next) => {
              choosePreset(next);
              setProblem("");
            }}
          />
          {grouped && groupedTable !== undefined && (
            <StudioSettingFields
              idPrefix={`${formId}-group`}
              properties={groupedTable.settings}
              values={groupValues}
              choices={choices}
              disabled={false}
              onChange={(next) => {
                setGroupValues(next);
                setProblem("");
              }}
            />
          )}
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
          <Button type="submit" form={formId}>
            Add {choice.name}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
