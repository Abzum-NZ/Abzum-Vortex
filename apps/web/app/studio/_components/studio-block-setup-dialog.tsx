"use client";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
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
  studioGridDataSettings,
  studioGroupedTableSettings,
  studioGroupedTableStart,
  studioSettingProblems,
  studioTablePresetProperty,
  type StudioCompositionSettings,
  type StudioPaletteChoice,
  type StudioSettingChoices,
} from "@vortex/ui/studio";

import { plainSettingValue, typedSourceSettingValue } from "@vortex/platform/schema";
import { useLeaveWarning } from "./use-leave-warning";

/** A new block whose required settings or query the person gives before it is added. */
export type StudioBlockSetupRequest = Readonly<{
  choice: StudioPaletteChoice;
  /** Where the block goes, in words. */
  description: string;
  /** The button that adds it, such as "Add Dialog". */
  action: string;
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
  const queries = [...draftChoices.queries, ...(draftChoices.recordQueries ?? [])];
  const [query, setQuery] = useState("");
  const [values, setValues] = useState<StudioCompositionSettings>({});
  // The Grouped table preset: the field it groups by and, for a date, the calendar unit.
  const [grouped, setGrouped] = useState(false);
  const [groupValues, setGroupValues] = useState<StudioCompositionSettings>({});
  const [problem, setProblem] = useState("");
  // Typed setup values are not in the draft until the block is added, so leaving asks first.
  const [touched, setTouched] = useState(false);
  useLeaveWarning(request !== null && touched);
  const formId = useId();
  // The draft's query list keeps its contents but not its identity across autosave and agent
  // edits, so the query choice follows the references themselves.
  const queriesKey = JSON.stringify(queries.map((candidate) => candidate.reference));
  const references = useMemo(() => JSON.parse(queriesKey) as string[], [queriesKey]);
  // A new request starts from its defaults; a draft edit while it is open keeps what was typed.
  useEffect(() => {
    setValues(setupDefaults(request?.choice));
    setGrouped(false);
    setGroupValues({});
    setProblem("");
    setTouched(false);
    setQuery("");
  }, [request]);
  // The chosen query stays while the draft still has it; otherwise the page's own query, then the first.
  useEffect(() => {
    setQuery((current) =>
      request?.choice.needsQuery !== true
        ? ""
        : references.includes(current)
          ? current
          : request.pageQuery !== undefined && references.includes(request.pageQuery)
            ? request.pageQuery
            : (references[0] ?? ""),
    );
  }, [request, references]);
  // A block without a query picks any field of the draft; one with a query, only that query's fields.
  const choices = useMemo(
    () => studioBlockChoices(draftChoices, query === "" ? null : query),
    [draftChoices, query],
  );
  // The bound query starts the Grouped table with the field it already groups by.
  const queryChoice = queries.find((candidate) => candidate.reference === query);
  const initializedData = useRef<{ request: StudioBlockSetupRequest | null; query: string } | null>(
    null,
  );
  useEffect(() => {
    if (initializedData.current?.request === request && initializedData.current.query === query)
      return;
    initializedData.current = { request, query };
    if (request === null || queryChoice === undefined) return;
    setValues({
      ...setupDefaults(request.choice),
      ...studioGridDataSettings(request.choice.setup, queryChoice),
    });
  }, [request, query, queryChoice]);
  const choosePreset = (next: StudioCompositionSettings) => {
    const preset = next["presentation"];
    const groupedPreset = preset?.kind === "choice" && preset.value === STUDIO_GROUPED_TABLE_PRESET;
    // Switching to Grouped table starts it as the query groups; other edits keep the chosen field.
    if (groupedPreset && !grouped) setGroupValues(studioGroupedTableStart(queryChoice));
    setGrouped(groupedPreset);
    setValues(groupedPreset ? { ...next, presentation: { kind: "choice", value: "grid" } } : next);
  };
  if (request === null) return null;
  const { choice } = request;
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
      onOpenChange={(open, eventDetails) => {
        if (open) return;
        // Typed values are not in the draft yet: a stray Escape or outside click keeps them, and
        // only Cancel or the close button leaves without adding the block.
        if (
          touched &&
          (eventDetails.reason === "escape-key" || eventDetails.reason === "outside-press")
        ) {
          setProblem("Add the block to keep these choices, or press Cancel to leave without it.");
          return;
        }
        onClose();
      }}
    >
      <DialogContent className="max-h-dvh overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Set up {choice.name}</DialogTitle>
          <DialogDescription>
            {request.description} You can change its settings in the inspector.
          </DialogDescription>
        </DialogHeader>
        <form id={formId} className="space-y-4" onSubmit={submit}>
          {choice.needsQuery && (
            <StudioQueryPicker
              id={`${formId}-query`}
              queries={draftChoices.queries}
              recordQueries={draftChoices.recordQueries}
              value={query}
              disabled={false}
              onChange={(next) => {
                setTouched(true);
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
              setTouched(true);
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
                setTouched(true);
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
            {request.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
