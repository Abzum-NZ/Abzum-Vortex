"use client";
import { plainSourceSettingValue } from "@vortex/platform/schema";
import type { StudioCompiledFields } from "../_lib/studio-data-model";
import {
  StudioField,
  StudioInspectorActions,
  StudioInspectorGroup,
  StudioReferencePicker,
  StudioHelp,
  StudioSegmentedControl,
} from "@vortex/ui/studio";
import { Icon } from "@vortex/ui";
import { Switch } from "@vortex/ui/components/switch";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";

import { useId, useMemo, useRef, useState } from "react";
import { studioPlacementLabels } from "../_lib/studio-labels";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import {
  describeStudioCompositionDestinations,
  describeStudioCompositionEdit,
  describeStudioCompositionRemoval,
  describeStudioCompositionSettings,
  describeStudioCompositionWrap,
  studioSemanticSelectionKey,
  studioBlockChoices,
  studioSettingProblems,
  StudioQueryPicker,
  StudioQueryBindings,
  studioQueryBindingFacts,
  studioRecordBindingFields,
  StudioSettingFields,
  StudioGridFeatures,
  boardModeOf,
  boardSettingChoices,
  studioBoardPipelines,
  studioGridFeaturesProperty,
  studioOwnsSetting,
  studioCanvasGridKey,
  type StudioCanvasGridArrangement,
  type StudioCompositionBreakpoint,
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

/** Stable option key of a move destination: its closed descriptor, not a serialised object. */
const destinationOptionKey = (destination: {
  readonly kind: string;
  readonly parentAlias?: string;
  readonly slotKey?: string;
}): string =>
  destination.kind === "child"
    ? `child:${encodeURIComponent(destination.parentAlias ?? "")}:${encodeURIComponent(destination.slotKey ?? "")}`
    : destination.kind;

const outcomeText = (result: StudioCompositionOutcome, fallback: string): string =>
  result.kind === "stale"
    ? "The draft or your selection changed. Try again."
    : result.kind === "unsupported"
      ? "This item does not support that change."
      : (result.reason ?? fallback);

/**
 * The selected item's settings, order, size and area. Every control edits the draft as it changes,
 * through the one composition command; input that is not valid yet stays here with its problem and
 * never reaches the draft. New blocks come from the Blocks panel's palette.
 */
export function ApplicationCompositionEditor(props: Props) {
  const [confirm, confirmDialog] = useConfirm();
  const [breakpoint, setBreakpoint] = useState<StudioCompositionBreakpoint>("desktop");
  const names = useMemo(() => studioPlacementLabels(props.context), [props.context]);
  const model = useMemo(
    () => describeStudioCompositionEdit(props.context, props.selection, breakpoint),
    [props.context, props.selection, breakpoint],
  );
  const moveModel = useMemo(
    () => describeStudioCompositionDestinations(props.context, props.selection),
    [props.context, props.selection],
  );
  const wrapModel = useMemo(
    () => describeStudioCompositionWrap(props.context, props.selection),
    [props.context, props.selection],
  );
  const removalModel = useMemo(
    () => describeStudioCompositionRemoval(props.context, props.selection),
    [props.context, props.selection],
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
  const [message, setMessage] = useState("");
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
  const destinations = moveModel.kind === "available" ? moveModel.destinations : [];
  const inputs = layout.value;
  const orderEditable = breakpoint === "desktop" || model.responsiveOrder;
  const selectedIndex = model.order.indexOf(model.placementAlias);
  const command = (next: StudioCompositionCommand, merge?: string, done = "Changed."): boolean => {
    if (props.disabled) return false;
    const result = props.onCommand(props.context, props.selection, next, merge);
    setMessage(
      result.kind === "applied"
        ? done
        : outcomeText(result, "Nothing changed. Use a valid size, order or destination."),
    );
    return result.kind === "applied";
  };
  // The query sheet answers after the draft changed: it chooses through the latest settings.
  const chooseQuery = useRef<(reference: string) => void>(() => undefined);
  chooseQuery.current = (reference) => changeSettings({ ...settingsInputs, query: reference });
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
  const changeSettings = (next: SettingsInputs) => {
    if (settingsModel.kind !== "available") return;
    const board = boardModeOf(next.settings);
    const featureGroup = next.settings.features;
    const boardValue = featureGroup?.kind === "group" ? featureGroup.properties.board : undefined;
    const boardDeclaration = featuresProperty?.properties.find(
      (property) => property.key === "board",
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
  const moveTo = (key: string) => {
    // Option values identify a current closed descriptor, never a source path or an array index.
    const chosen = destinations.find((item) => destinationOptionKey(item.destination) === key);
    if (chosen === undefined) {
      setMessage("This destination is no longer available.");
      return;
    }
    command({ kind: "move", destination: chosen.destination }, undefined, "Item moved.");
  };
  const wrapIn = (key: string) => {
    const chosen =
      wrapModel.kind === "available"
        ? wrapModel.containers.find((item) => `${item.blockId}:${item.releaseVersion}` === key)
        : undefined;
    if (chosen === undefined) {
      setMessage("This container is no longer available.");
      return;
    }
    command(
      { kind: "wrap", blockId: chosen.blockId, releaseVersion: chosen.releaseVersion },
      undefined,
      `Item placed in a new ${chosen.name.toLowerCase()}.`,
    );
  };
  const remove = async () => {
    if (
      props.disabled ||
      describeStudioCompositionRemoval(props.context, props.selection).kind !== "available"
    ) {
      setMessage("This item cannot be removed. Nothing was changed.");
      return;
    }
    const confirmed = await confirm({
      title: "Remove this item?",
      description: "The item is removed from your draft. Undo brings it back.",
      confirmLabel: "Remove item",
      cancelLabel: "Keep item",
      destructive: true,
    });
    if (confirmed) command({ kind: "remove" }, undefined, "Item removed.");
  };

  return (
    <section className="space-y-6" aria-labelledby={titleId}>
      <header className="flex items-start justify-between gap-2">
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
            {
              label: "Remove",
              destructive: true,
              disabled: props.disabled || removalModel.kind !== "available",
              onSelect: () => {
                void remove();
              },
            },
          ]}
        />
      </header>
      {settingsModel.kind === "available" ? (
        <StudioInspectorGroup title="Settings">
          <fieldset className="space-y-4" disabled={props.disabled}>
            {settingsModel.readsQuery && (
              <StudioQueryPicker
                id={`${settingsId}-query`}
                queries={props.choices.queries}
                value={settingsInputs.query ?? ""}
                disabled={props.disabled}
                onNewQuery={
                  props.onNewQuery === undefined
                    ? undefined
                    : () => props.onNewQuery?.((reference) => chooseQuery.current(reference))
                }
                onChange={(query) =>
                  changeSettings({ ...settingsInputs, query: query === "" ? null : query })
                }
              />
            )}
            {settingsModel.readsQuery && (
              <StudioQueryBindings
                choices={choices}
                query={props.choices.queries.find(
                  (query) => query.reference === settingsInputs.query,
                )}
                value={settingsInputs.settings.query_parameters}
                facts={studioQueryBindingFacts(
                  props.context,
                  settingsModel.placementAlias,
                  props.choices.queries,
                )}
                disabled={props.disabled}
                onChange={(value) =>
                  changeSettings({
                    ...settingsInputs,
                    settings: { ...settingsInputs.settings, query_parameters: value },
                  })
                }
              />
            )}
            <StudioSettingFields
              idPrefix={settingsId}
              properties={settingsModel.properties.filter(
                (property) =>
                  property !== featuresProperty &&
                  property.key !== "query_parameters" &&
                  property.key !== "row_actions" &&
                  !studioOwnsSetting(property.key),
              )}
              values={settingsInputs.settings}
              choices={choices}
              disabled={props.disabled}
              onChange={(settings) => changeSettings({ ...settingsInputs, settings })}
            />
          </fieldset>
          <StudioHelp hint="A setting you leave unset uses its default." />
          {settings.problem !== "" && (
            <p role="alert" className="text-sm text-destructive">
              {settings.problem}
            </p>
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
              recordType.slice(recordType.indexOf(":") + 1).replaceAll("_", " "),
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
            changeSettings({
              ...settingsInputs,
              settings: { ...settingsInputs.settings, [featuresProperty.key]: features },
            })
          }
        />
      )}
      <StudioInspectorGroup title="Behaviour">
        <StudioField label="Screen size">
          {() => (
            <StudioSegmentedControl
              label="Screen size"
              value={breakpoint}
              disabled={props.disabled}
              onChange={setBreakpoint}
              options={[
                { value: "desktop", label: "Desktop", icon: <Icon name="monitor" /> },
                { value: "tablet", label: "Tablet", icon: <Icon name="tablet" /> },
                { value: "phone", label: "Phone", icon: <Icon name="smartphone" /> },
              ]}
            />
          )}
        </StudioField>
        <fieldset
          className="space-y-2"
          disabled={props.disabled || !orderEditable}
          aria-describedby={hintId}
        >
          <legend className="text-sm font-medium">Order among its neighbours</legend>
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
          <legend className="text-sm font-medium">Size</legend>
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
            <p role="alert" className="text-sm text-destructive">
              {layout.problem}
            </p>
          )}
          <StudioHelp
            hint={
              model.explicitLayout
                ? "This size is set for this screen size."
                : "This size is inherited from the larger screen size."
            }
          />
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
        <StudioField
          label="Move to another area"
          hint="Moves this item, with what is inside it, to the end of the area you choose in this page or layout. Required content and nesting limits are checked first."
        >
          {(control) => (
            <StudioReferencePicker
              {...control}
              value=""
              unset="Choose a destination"
              disabled={props.disabled || destinations.length === 0}
              options={destinations.map((item) => ({
                value: destinationOptionKey(item.destination),
                label:
                  item.destination.kind === "child"
                    ? `${names.get(item.destination.parentAlias) ?? "Item"} / ${item.label.slice(item.label.indexOf(" / ") + 3)}`
                    : item.label,
              }))}
              onChange={(next) => {
                if (next !== "") moveTo(next);
              }}
            />
          )}
        </StudioField>
        {destinations.length === 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            {moveModel.kind === "unsupported"
              ? "Items can only be moved within the main area of an ordinary page or a layout."
              : "There is no other area this item can move to."}
          </p>
        )}
        {wrapModel.kind === "available" && wrapModel.containers.length > 0 && (
          <StudioField
            label="Place in a new container"
            hint="Puts this item into a new container that takes its place. The item keeps its name, settings and order. Containers that cannot hold it say why."
          >
            {(control) => (
              <StudioReferencePicker
                {...control}
                value=""
                unset="Choose a container"
                disabled={props.disabled}
                options={wrapModel.containers.map((item) => ({
                  value: `${item.blockId}:${item.releaseVersion}`,
                  label:
                    item.unavailable === undefined
                      ? item.name
                      : `${item.name} (not possible: ${item.unavailable})`,
                }))}
                onChange={(next) => {
                  if (next !== "") wrapIn(next);
                }}
              />
            )}
          </StudioField>
        )}
        {removalModel.kind !== "available" && (
          <p
            role="status"
            className="text-sm text-muted-foreground"
            aria-label="Removal restrictions"
          >
            {removalModel.kind === "blocked"
              ? removalModel.reason === "required_slot"
                ? "This area needs at least this item."
                : removalModel.reason === "unresolved_target"
                  ? "Something this item points to cannot be found. It cannot be removed."
                  : "A flow still uses this item. It cannot be removed."
              : "Only display items in the main area of a list, detail or dashboard page can be removed."}
          </p>
        )}
      </StudioInspectorGroup>
      <p role="status" aria-live="polite">
        {message}
      </p>
      {confirmDialog}
    </section>
  );
}
