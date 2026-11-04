"use client";
import { FieldLegend } from "@vortex/ui/components/field";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
import { plainSourceSettingValue, recordsTableBoardFeature } from "@vortex/platform/schema";
import type { StudioCompiledFields } from "../_lib/studio-data-model";
import {
  StudioField,
  StudioInspectorActions,
  StudioInspectorGroup,
  StudioHelp,
  StudioSegmentedControl,
} from "@vortex/ui/studio";
import { Icon } from "@vortex/ui";
import { studioScreens, useStudioScreen } from "@vortex/ui/studio/puck-provider";
import { Switch } from "@vortex/ui/components/switch";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";

import { useId, useMemo, useRef, useState } from "react";
import { studioPlacementLabels } from "../_lib/studio-labels";
import {
  describeStudioCompositionEdit,
  describeStudioCompositionSettings,
  studioOutcomeText,
  studioSemanticSelectionKey,
  studioBlockChoices,
  followFieldLabels,
  studioGridDataSettings,
  studioSettingProblems,
  StudioSelectionControlBinding,
  studioQueryBindingFacts,
  studioRecordBindingFields,
  StudioBlockSettingFields,
  StudioGridFeatures,
  boardModeOf,
  boardSettingChoices,
  studioBoardPipelines,
  studioGridFeaturesProperty,
  studioCanvasGridKey,
  type StudioCanvasGridArrangement,
  type StudioCompositionCommand,
  type StudioCompositionContext,
  type StudioCompositionLayout,
  type StudioCompositionOutcome,
  type StudioCompositionSettings,
  type StudioCompositionSettingsModel,
  type StudioSemanticSelection,
  type StudioSettingChoices,
} from "@vortex/ui/studio";
import { useStudioDraftHeld } from "./use-studio-draft-held";
import { StudioTableAddRecords } from "./studio-table-add-records";

type Props = Readonly<{
  context: StudioCompositionContext;
  selection: StudioSemanticSelection;
  disabled: boolean;
  /** What reference settings can point at, read from the draft being edited. */
  choices: StudioSettingChoices;
  /** The saved draft's compiled fields by record type, for the typed condition controls. */
  compiledFields: StudioCompiledFields | null;
  canvasArrangement?: StudioCanvasGridArrangement | undefined;
  /**
   * Opens the query sheet; `use` chooses the query it made as this block's data. It runs after the
   * new query is in the draft, so the block's choices already offer it.
   */
  onNewQuery?: ((use: (reference: string) => void) => void) | undefined;
  /** The one composition edit; `merge` joins a run of edits to one value into one Undo step. */
  onCommand: (
    expected: StudioCompositionContext,
    selection: StudioSemanticSelection,
    command: StudioCompositionCommand,
    merge?: string,
  ) => StudioCompositionOutcome;
}>;

type LayoutInputs = Readonly<{
  visible: boolean;
  width: "content" | "fill" | "grid";
  startColumn: string;
  span: string;
  height: "content" | "bounded";
  units: string;
}>;
const inputsFor = (layout: StudioCompositionLayout): LayoutInputs => ({
  visible: layout.visible,
  width: layout.width.kind,
  startColumn: layout.width.kind === "grid" ? String(layout.width.start_column) : "1",
  span: layout.width.kind === "grid" ? String(layout.width.span) : "12",
  height: layout.height.kind,
  units: layout.height.kind === "bounded" ? String(layout.height.units) : "1",
});
const columnNumber = (text: string): number | undefined => {
  const value = Number(text);
  return text.trim() !== "" && Number.isInteger(value) && value >= 1 && value <= 12
    ? value
    : undefined;
};
/** The layout the inputs describe, or the problem that keeps them from the draft. */
const layoutOf = (
  inputs: LayoutInputs,
): Readonly<{ layout: StudioCompositionLayout } | { problem: string }> => {
  const start = columnNumber(inputs.startColumn);
  const span = columnNumber(inputs.span);
  const units = Number(inputs.units);
  if (inputs.width === "grid" && (start === undefined || span === undefined))
    return { problem: "Columns are whole numbers from 1 to 12." };
  if (
    inputs.height === "bounded" &&
    (inputs.units.trim() === "" || !Number.isFinite(units) || units < 0)
  )
    return { problem: "A fixed height is a number of zero or more." };
  return {
    layout: {
      visible: inputs.visible,
      width:
        inputs.width === "grid"
          ? { kind: "grid", start_column: start!, span: span! }
          : inputs.width === "content"
            ? { kind: "content" }
            : { kind: "fill" },
      height: inputs.height === "bounded" ? { kind: "bounded", units } : { kind: "content" },
    } as StudioCompositionLayout,
  };
};
/** The settings form's input: the block's set settings and the query it reads. */
type SettingsInputs = Readonly<{ settings: StudioCompositionSettings; query: string | null }>;
const settingsInputsFor = (model: StudioCompositionSettingsModel): SettingsInputs =>
  model.kind === "available"
    ? { settings: model.settings, query: model.query }
    : { settings: {}, query: null };
const fieldClass = "w-full";

/**
 * The selected item's settings, order, size and area. Every control edits the draft as it changes,
 * through the one composition command; input that is not valid yet stays here with its problem and
 * never reaches the draft. New blocks come from the Blocks panel's palette.
 */
export function ApplicationCompositionEditor(props: Props) {
  // The screen is the canvas screen: one state, kept by Puck.
  const { breakpoint, choose: chooseScreen } = useStudioScreen();
  const names = useMemo(() => studioPlacementLabels(props.context), [props.context]);
  const model = useMemo(
    () => describeStudioCompositionEdit(props.context, props.selection, breakpoint),
    [props.context, props.selection, breakpoint],
  );
  const settingsModel = useMemo(
    () => describeStudioCompositionSettings(props.context, props.selection),
    [props.context, props.selection],
  );
  const selectionKey = studioSemanticSelectionKey(props.selection);
  // Input that is not valid yet stays in its control; the draft changing under it (Undo, Redo, another
  // screen size) drops it. The workspace keys this editor by the selected item.
  const settings = useStudioDraftHeld(settingsInputsFor(settingsModel));
  const layout = useStudioDraftHeld(model.kind === "available" ? inputsFor(model.layout) : null);
  const [problemArea, setProblemArea] = useState<"settings" | "features">("settings");
  // A success is announced to a screen reader; a refusal stays on screen for everyone.
  const [message, setMessage] = useState<Readonly<{ text: string; failed: boolean; at: number }>>({
    text: "",
    failed: false,
    at: 0,
  });
  // The refusal belongs to the draft it was made against: another change by any path clears it.
  const [refusedOn, setRefusedOn] = useState(props.context.source);
  if (message.failed && refusedOn !== props.context.source) {
    setRefusedOn(props.context.source);
    setMessage((previous) => ({ ...previous, text: "", failed: false }));
  }
  const titleId = useId();
  const hintId = useId();
  const settingsId = useId();
  const settingsInputs = settings.value;
  // The reference settings point at the fields of the data the block reads, or, for a block that
  // reads none, at the application's own fields.
  const choices = useMemo(
    () => studioBlockChoices(props.choices, settingsInputs.query),
    [props.choices, settingsInputs.query],
  );
  // The query sheet answers after the draft changed: it chooses through the latest settings.
  const chooseQuery = useRef<(reference: string) => void>(() => undefined);

  if (model.kind !== "available" || layout.value === null)
    return (
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Item order and size</h3>
        <p role="status" className="text-sm text-muted-foreground">
          {model.kind === "unsupported"
            ? "This area uses an item type that cannot be edited here. Nothing was changed."
            : "This item is not in the current draft."}
        </p>
      </section>
    );

  // A Records table's grid features are edited in their own Features panel, not as a setting group.
  const featuresProperty =
    settingsModel.kind === "available"
      ? studioGridFeaturesProperty(settingsModel.properties)
      : undefined;
  // Adding records from a list opens a create form, so the form is chosen before the switch appears.
  const addsFromList =
    settingsModel.kind === "available" &&
    settingsModel.properties.some((property) => property.key === "inline_create") &&
    settingsModel.properties.some((property) => property.key === "create_page");
  const createPageSetting = settingsInputs.settings.create_page;
  const inlineCreateSetting = settingsInputs.settings.inline_create;
  const createForm = createPageSetting?.kind === "page_reference" ? createPageSetting.page : "";
  const addsRecords = inlineCreateSetting?.kind === "boolean" && inlineCreateSetting.value;
  // A canvas arrangement belongs to the query, columns and density it was made for.
  const canvasMatches =
    props.canvasArrangement?.key ===
    studioCanvasGridKey(
      settingsInputs.query,
      Object.fromEntries(
        Object.entries(settingsInputs.settings).map(([key, value]) => [
          key,
          plainSourceSettingValue(value),
        ]),
      ),
    );
  const inputs = layout.value;
  const widthWord =
    inputs.width === "fill"
      ? "Full width"
      : inputs.width === "content"
        ? "Fits content"
        : `${inputs.span} columns`;
  const layoutSummary = `${breakpoint.charAt(0).toUpperCase()}${breakpoint.slice(1)} · ${widthWord}`;
  const orderEditable = breakpoint === "desktop" || model.responsiveOrder;
  const selectedIndex = model.order.indexOf(model.placementAlias);
  const command = (next: StudioCompositionCommand, merge?: string, done = "Changed."): boolean => {
    if (props.disabled) return false;
    const result = props.onCommand(props.context, props.selection, next, merge);
    setRefusedOn(props.context.source);
    setMessage((previous) => ({
      text:
        result.kind === "applied"
          ? done
          : studioOutcomeText(result, "Nothing changed. Use a valid size or order."),
      failed: result.kind !== "applied",
      at: previous.at + 1,
    }));
    return result.kind === "applied";
  };
  const changeQuery = (reference: string) => {
    const properties = settingsModel.kind === "available" ? settingsModel.properties : [];
    const query = reference === "" ? null : reference;
    const data = Object.fromEntries(
      Object.entries(
        studioGridDataSettings(
          properties,
          [...props.choices.queries, ...(props.choices.recordQueries ?? [])].find(
            (candidate) => candidate.reference === reference,
          ),
        ),
      ).filter(([key]) => key !== "title"),
    );
    // A label copied from the old data's field follows the field the new data offers.
    changeSettings({
      query,
      settings: followFieldLabels(
        properties,
        { ...settingsInputs.settings, ...data },
        settingsInputs.settings,
        studioBlockChoices(props.choices, query).fields,
        choices.fields,
      ),
    });
  };
  chooseQuery.current = changeQuery;
  const changeLayout = (next: LayoutInputs) => {
    const described = layoutOf(next);
    if ("problem" in described) {
      layout.hold(next, described.problem);
      return;
    }
    if (
      command(
        { kind: "resize", breakpoint, layout: described.layout },
        `size:${selectionKey}:${breakpoint}`,
        "Size changed.",
      )
    )
      layout.applied(next);
    else layout.hold(next, "");
  };
  const changeSettings = (next: SettingsInputs, area: "settings" | "features" = "settings") => {
    setProblemArea(area);
    if (settingsModel.kind !== "available") return;
    const board = boardModeOf(next.settings);
    const featureGroup = next.settings.features;
    const boardValue = featureGroup?.kind === "group" ? featureGroup.properties.board : undefined;
    const boardDeclaration = featuresProperty?.properties.find(
      (property) => property.key === recordsTableBoardFeature.key,
    );
    // A pipeline selection writes its query in the same composition command. Check its real
    // record fields before that write, rather than the previous query's selected fields.
    // Dormant table mappings retain structural validation, as they do at publication.
    const mappingProblems =
      board !== undefined && boardDeclaration !== undefined && boardValue !== undefined
        ? [
            ...studioSettingProblems(next.settings, settingsModel.properties),
            ...studioSettingProblems(
              { board: boardValue },
              [boardDeclaration],
              boardSettingChoices(props.choices, board),
            ),
          ]
        : studioSettingProblems(
            next.settings,
            settingsModel.properties,
            studioBlockChoices(props.choices, next.query),
          );
    const problems = [
      ...(settingsModel.readsQuery &&
      next.query === null &&
      (board?.columnField === undefined || board.cardTitleField === undefined)
        ? ["Choose the data this block shows."]
        : []),
      ...mappingProblems,
    ];
    if (problems.length > 0) {
      settings.hold(next, problems.join(" "));
      return;
    }
    if (
      command(
        { kind: "settings", settings: next.settings, query: next.query },
        `settings:${selectionKey}`,
        "Settings changed.",
      )
    )
      settings.applied(next);
    else settings.hold(next, "");
  };
  const move = (direction: -1 | 1) => {
    if (!orderEditable || selectedIndex < 0) return;
    const nextIndex = selectedIndex + direction;
    if (nextIndex < 0 || nextIndex >= model.order.length) return;
    const next = [...model.order];
    const moved = next.splice(selectedIndex, 1)[0];
    if (moved === undefined) return;
    next.splice(nextIndex, 0, moved);
    command({ kind: "order", breakpoint, order: next }, undefined, "Order changed.");
  };
  return (
    <section aria-labelledby={titleId}>
      <header className="flex items-start justify-between gap-2 pb-3">
        <div className="min-w-0">
          <h2 id={titleId} className="flex min-w-0 items-center gap-2 text-base font-semibold">
            <Icon name="blocks" className="size-4 shrink-0" />
            <span className="truncate">{names.get(model.placementAlias) ?? "Block"}</span>
          </h2>
          <p className="text-xs text-muted-foreground">Block</p>
        </div>
        <StudioInspectorActions
          actions={[
            {
              label: "Move up",
              disabled: props.disabled || !orderEditable || selectedIndex <= 0,
              onSelect: () => move(-1),
            },
            {
              label: "Move down",
              disabled:
                props.disabled ||
                !orderEditable ||
                selectedIndex < 0 ||
                selectedIndex >= model.order.length - 1,
              onSelect: () => move(1),
            },
          ]}
        />
      </header>
      {settingsModel.kind === "available" ? (
        <StudioInspectorGroup title="Settings" hint="A setting you leave unset uses its default.">
          <fieldset className="space-y-4" disabled={props.disabled}>
            {addsFromList && (
              <StudioTableAddRecords
                form={createForm}
                adding={addsRecords === true}
                pages={choices.pages}
                disabled={props.disabled}
                onChange={(next) => {
                  const settings = { ...settingsInputs.settings };
                  if (next.form === "") delete settings.create_page;
                  else settings.create_page = { kind: "page_reference", page: next.form };
                  if (next.adding) settings.inline_create = { kind: "boolean", value: true };
                  else delete settings.inline_create;
                  changeSettings({ ...settingsInputs, settings });
                }}
              />
            )}
            <StudioBlockSettingFields
              choices={choices}
              disabled={props.disabled}
              placementAlias={model.placementAlias}
              query={
                settingsModel.readsQuery
                  ? {
                      value: settingsInputs.query ?? "",
                      queries: props.choices.queries,
                      recordQueries: props.choices.recordQueries ?? [],
                      onChange: changeQuery,
                      onNewQuery:
                        props.onNewQuery === undefined
                          ? undefined
                          : () => props.onNewQuery?.((reference) => chooseQuery.current(reference)),
                      bindings: {
                        value: settingsInputs.settings.query_parameters,
                        facts: studioQueryBindingFacts(
                          props.context,
                          settingsModel.placementAlias,
                          props.choices.queries,
                        ),
                        onChange: (value) =>
                          changeSettings({
                            ...settingsInputs,
                            settings: { ...settingsInputs.settings, query_parameters: value },
                          }),
                      },
                    }
                  : undefined
              }
            />
            {(["open_with", "record_from"] as const)
              .filter((key) => settingsModel.properties.some((property) => property.key === key))
              .map((key) => (
                <StudioSelectionControlBinding
                  key={key}
                  setting={key}
                  value={settingsInputs.settings[key]}
                  facts={studioQueryBindingFacts(
                    props.context,
                    settingsModel.placementAlias,
                    props.choices.queries,
                  )}
                  disabled={props.disabled}
                  onChange={(value) => {
                    const next = { ...settingsInputs.settings };
                    if (value === undefined) delete next[key];
                    else next[key] = value;
                    changeSettings({ ...settingsInputs, settings: next });
                  }}
                />
              ))}
          </fieldset>
          {settings.problem !== "" && problemArea === "settings" && (
            <Alert variant="destructive">
              <AlertDescription>{settings.problem}</AlertDescription>
            </Alert>
          )}
        </StudioInspectorGroup>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {settingsModel.kind === "unsupported"
            ? "This item's settings can't be changed here."
            : "This item's settings can't be read."}
        </p>
      )}
      {featuresProperty === undefined ? null : (
        <StudioGridFeatures
          idPrefix={`${settingsId}-features`}
          property={featuresProperty}
          problem={problemArea === "features" ? settings.problem : ""}
          tableSettings={settingsInputs.settings}
          canvasArrangement={canvasMatches ? props.canvasArrangement?.state : undefined}
          canvasStale={props.canvasArrangement !== undefined && !canvasMatches}
          signedIn={settingsModel.kind === "available" && settingsModel.signedIn}
          value={settingsInputs.settings[featuresProperty.key]}
          presentation={(() => {
            const setting =
              settingsInputs.settings.presentation ??
              (settingsModel.kind === "available"
                ? settingsModel.properties.find((property) => property.key === "presentation")
                    ?.defaultValue
                : undefined);
            if (
              setting?.kind !== "choice" ||
              (setting.value !== "grid" && setting.value !== "cards")
            )
              throw new Error("Data grid preset is missing its declared setting");
            return setting.value;
          })()}
          query={props.choices.queries.find((query) => query.reference === settingsInputs.query)}
          compiledFields={(() => {
            const query = props.choices.queries.find(
              (candidate) => candidate.reference === settingsInputs.query,
            );
            return query === undefined
              ? undefined
              : props.compiledFields?.recordTypes[query.recordType];
          })()}
          choices={choices}
          boardChoices={boardSettingChoices(props.choices, boardModeOf(settingsInputs.settings))}
          pipelines={studioBoardPipelines(
            props.context.source,
            settingsModel.kind === "available" ? settingsModel.placementAlias : undefined,
          )}
          related={{
            queries: props.choices.queries,
            relationships: props.choices.relationships,
            recordTypeLabel: (recordType) =>
              props.choices.recordTypes.find((candidate) => candidate.key === recordType)?.label ??
              "A removed item",
            page:
              settingsModel.kind === "available"
                ? studioQueryBindingFacts(
                    props.context,
                    settingsModel.placementAlias,
                    props.choices.queries,
                  )
                : studioQueryBindingFacts(props.context, "", props.choices.queries),
            rowFields: studioRecordBindingFields(
              props.context.source,
              props.choices.queries.find((query) => query.reference === settingsInputs.query)
                ?.recordType ?? "",
            ),
          }}
          disabled={props.disabled}
          onChange={(features) =>
            changeSettings(
              {
                ...settingsInputs,
                settings: { ...settingsInputs.settings, [featuresProperty.key]: features },
              },
              "features",
            )
          }
        />
      )}
      <StudioInspectorGroup title="Layout" defaultOpen={false} summary={layoutSummary}>
        <StudioField label="Screen size">
          {() => (
            <StudioSegmentedControl
              label="Screen size"
              value={breakpoint}
              disabled={props.disabled}
              onChange={chooseScreen}
              options={studioScreens.map((screen) => ({
                value: screen.breakpoint,
                label: screen.label,
                icon: <Icon name={screen.icon} />,
              }))}
            />
          )}
        </StudioField>
        <fieldset
          className="space-y-2"
          disabled={props.disabled || !orderEditable}
          aria-describedby={hintId}
        >
          <FieldLegend variant="label" className="flex items-center gap-1">
            Order among its neighbours
            <StudioHelp
              id={hintId}
              hint={
                breakpoint !== "desktop" && !model.responsiveOrder
                  ? "This area uses one order at every screen size."
                  : model.explicitOrder
                    ? "This order is set for this screen size."
                    : "This order is inherited from the larger screen size."
              }
            />
          </FieldLegend>
          <ol className="space-y-px">
            {model.order.map((alias, index) => (
              <li
                key={alias}
                aria-current={alias === model.placementAlias ? "true" : undefined}
                className={
                  alias === model.placementAlias
                    ? "flex items-center gap-2 rounded-md bg-muted px-2 py-1 text-sm font-medium"
                    : "flex items-center gap-2 rounded-md px-2 py-1 text-sm"
                }
              >
                <span className="w-4 text-xs text-muted-foreground tabular-nums">{index + 1}</span>
                <span className="truncate">{names.get(alias) ?? "Item"}</span>
              </li>
            ))}
          </ol>
          {breakpoint !== "desktop" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!model.explicitOrder}
              onClick={() => {
                command({ kind: "order", breakpoint, order: null }, undefined, "Order changed.");
              }}
            >
              <Icon name="undo" />
              Use the larger screen&apos;s order
            </Button>
          )}
        </fieldset>
        <fieldset className="space-y-4" disabled={props.disabled}>
          <FieldLegend variant="label" className="flex items-center gap-1">
            Size
            <StudioHelp
              hint={
                model.explicitLayout
                  ? "This size is set for this screen size."
                  : "This size is inherited from the larger screen size."
              }
            />
          </FieldLegend>
          <label className="flex items-center justify-between gap-2 text-sm">
            Shown at this screen size
            <Switch
              checked={inputs.visible}
              disabled={props.disabled || !model.capabilities.responsiveVisibility}
              onCheckedChange={(checked) => changeLayout({ ...inputs, visible: checked })}
            />
          </label>
          <StudioField label="Width">
            {() => (
              <StudioSegmentedControl
                label="Width"
                value={inputs.width}
                disabled={props.disabled}
                onChange={(width) => changeLayout({ ...inputs, width })}
                options={[
                  { value: "content", label: "Content" },
                  { value: "fill", label: "Fill" },
                  ...(model.capabilities.gridWidth
                    ? [{ value: "grid" as const, label: "Columns" }]
                    : []),
                ]}
              />
            )}
          </StudioField>
          {inputs.width === "grid" && (
            <div className="grid grid-cols-2 gap-2">
              <StudioField label="Starts at column">
                {(control) => (
                  <Input
                    {...control}
                    className={fieldClass}
                    type="number"
                    required
                    min={1}
                    max={12}
                    step={1}
                    value={inputs.startColumn}
                    onChange={(event) =>
                      changeLayout({ ...inputs, startColumn: event.target.value })
                    }
                  />
                )}
              </StudioField>
              <StudioField label="Number of columns">
                {(control) => (
                  <Input
                    {...control}
                    className={fieldClass}
                    type="number"
                    required
                    min={1}
                    max={12}
                    step={1}
                    value={inputs.span}
                    onChange={(event) => changeLayout({ ...inputs, span: event.target.value })}
                  />
                )}
              </StudioField>
            </div>
          )}
          <StudioField label="Height">
            {() => (
              <StudioSegmentedControl
                label="Height"
                value={inputs.height}
                disabled={props.disabled}
                onChange={(height) => changeLayout({ ...inputs, height })}
                options={[
                  { value: "content", label: "Content" },
                  ...(model.capabilities.height === "content_or_bounded"
                    ? [{ value: "bounded" as const, label: "Fixed height" }]
                    : []),
                ]}
              />
            )}
          </StudioField>
          {inputs.height === "bounded" && (
            <StudioField label="Fixed height">
              {(control) => (
                <Input
                  {...control}
                  className={fieldClass}
                  type="number"
                  required
                  min={0}
                  step="any"
                  value={inputs.units}
                  onChange={(event) => changeLayout({ ...inputs, units: event.target.value })}
                />
              )}
            </StudioField>
          )}
          {layout.problem !== "" && (
            <Alert variant="destructive">
              <AlertDescription>{layout.problem}</AlertDescription>
            </Alert>
          )}
          {breakpoint !== "desktop" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={props.disabled || !model.explicitLayout}
              onClick={() => {
                command({ kind: "resize", breakpoint, layout: null }, undefined, "Size changed.");
              }}
            >
              <Icon name="undo" />
              Use the larger screen&apos;s size
            </Button>
          )}
        </fieldset>
      </StudioInspectorGroup>
      <p role="status" aria-live="polite" className="sr-only">
        {message.failed ? "" : message.text}
      </p>
      {message.failed && (
        <Alert key={message.at} variant="destructive">
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}
