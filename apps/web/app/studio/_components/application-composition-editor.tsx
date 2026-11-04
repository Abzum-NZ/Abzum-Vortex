"use client";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
import {
  plainSourceSettingValue,
  recordsTableBoardFeature,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import type { StudioCompiledFields } from "../_lib/studio-data-model";
import { StudioInspectorGroup } from "@vortex/ui/studio";
import { useStudioScreen } from "@vortex/ui/studio/puck-provider";

import { useId, useMemo, useRef, useState } from "react";
import { studioPlacementLabel } from "../_lib/studio-labels";
import {
  describeStudioCompositionEdit,
  describeStudioCompositionSettings,
  studioOutcomeText,
  studioSemanticSelectionKey,
  studioBlockChoices,
  studioFormFieldsInUseFor,
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
  type StudioQueryChoice,
  type StudioCompositionCommand,
  type StudioCompositionContext,
  type StudioCompositionOutcome,
  type StudioLayoutFieldValue,
  type StudioCompositionSettings,
  type StudioCompositionSettingsModel,
  type StudioSemanticSelection,
  type StudioSettingChoices,
  type StudioStoredApplicationDraft,
} from "@vortex/ui/studio";
import { useStudioDraftHeld } from "@vortex/ui/studio";
import { StudioTableAddRecords } from "./studio-table-add-records";
import { useStudioBlockAccess } from "./studio-block-access";

type Props = Readonly<{
  context: StudioCompositionContext;
  selection: StudioSemanticSelection;
  /** Selection key to the label Studio shows, from the draft's one outline. */
  labels: ReadonlyMap<string, string>;
  disabled: boolean;
  /** What reference settings can point at, read from the draft being edited. */
  choices: StudioSettingChoices;
  /** The saved draft's compiled fields by record type, for the typed condition controls. */
  compiledFields: StudioCompiledFields | null;
  /** The saved draft, whose compiled fields a condition can name. */
  saved: StudioStoredApplicationDraft;
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
  /** One condition of the block (when it shows, is required, is read-only or is enabled). */
  onReaction: Parameters<typeof useStudioBlockAccess>[0]["onReaction"];
}>;

/** The settings form's input: the block's set settings and the query it reads. */
type SettingsInputs = Readonly<{ settings: StudioCompositionSettings; query: string | null }>;
const settingsInputsFor = (model: StudioCompositionSettingsModel): SettingsInputs =>
  model.kind === "available"
    ? { settings: model.settings, query: model.query }
    : { settings: {}, query: null };
const chooseDataProblem = "Choose the data this block shows.";
const noQueries: readonly StudioQueryChoice[] = [];

/**
 * The selected item's settings, order, size and area. Every control edits the draft as it changes,
 * through the one composition command; input that is not valid yet stays here with its problem and
 * never reaches the draft. New blocks come from the Blocks panel's palette.
 */
export function ApplicationCompositionEditor(props: Props) {
  // The screen is the canvas screen: one state, kept by Puck.
  const { breakpoint, choose: chooseScreen } = useStudioScreen();
  const { labels } = props;
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
  const settingsFromDraft = useMemo(() => settingsInputsFor(settingsModel), [settingsModel]);
  const settings = useStudioDraftHeld(settingsFromDraft);
  const [problemArea, setProblemArea] = useState<"settings" | "features">("settings");
  // A success is announced to a screen reader; a refusal stays on screen for everyone.
  const [message, setMessage] = useState<
    Readonly<{ text: string; failed: boolean; area: "gate" | "settings"; at: number }>
  >({ text: "", failed: false, area: "settings", at: 0 });
  // The refusal belongs to the draft it was made against: another change by any path clears it.
  const [refusedOn, setRefusedOn] = useState(props.context.source);
  if (message.failed && refusedOn !== props.context.source) {
    setRefusedOn(props.context.source);
    setMessage((previous) => ({ ...previous, text: "", failed: false }));
  }
  const titleId = useId();
  const settingsId = useId();
  const settingsInputs = settings.value;
  /**
   * Runs one composition command; answers the words of its refusal, or undefined once the draft
   * took it. A size or an order says its refusal at its own field (`atField`).
   */
  const command = (
    next: StudioCompositionCommand,
    merge?: string,
    done = "Changed.",
    fallback = "Nothing changed. Use a valid size or order.",
    atField = false,
  ): string | undefined => {
    if (props.disabled) return fallback;
    const result = props.onCommand(props.context, props.selection, next, merge);
    // An expected refusal logs once, at info.
    if (result.kind !== "applied")
      console.info("[studio] composition change refused", next.kind, result.kind);
    const text = result.kind === "applied" ? undefined : studioOutcomeText(result, fallback);
    setRefusedOn(props.context.source);
    setMessage((previous) => ({
      text: text ?? done,
      failed: text !== undefined && !atField,
      area: next.kind === "gate" ? "gate" : "settings",
      at: previous.at + 1,
    }));
    return text;
  };
  // The layout fields call the latest handler, so their value keeps its identity between renders.
  const run = useRef(command);
  run.current = command;
  const layoutValue = useMemo<StudioLayoutFieldValue>(
    () =>
      model.kind === "available"
        ? {
            kind: "available",
            model,
            labelOf: (alias) => studioPlacementLabel(labels, alias) ?? "Item",
            onResize: (next) =>
              run.current(
                { kind: "resize", breakpoint, layout: next },
                next === null ? undefined : `size:${selectionKey}:${breakpoint}`,
                "Size changed.",
                undefined,
                true,
              ),
            onOrder: (next) =>
              run.current(
                { kind: "order", breakpoint, order: next },
                undefined,
                "Order changed.",
                undefined,
                true,
              ),
          }
        : {
            kind: "refused",
            reason:
              model.kind === "unsupported"
                ? "This area uses an item type that cannot be edited here. Nothing was changed."
                : "This item is not in the current draft.",
          },
    [model, labels, breakpoint, selectionKey],
  );
  // Who sees the block and when: its gate and conditions are fields of the Visibility and access group.
  const { access, dialog: conditionDialog } = useStudioBlockAccess({
    context: props.context,
    selection: props.selection,
    saved: props.saved,
    disabled: props.disabled,
    gateProblem: message.failed && message.area === "gate" ? message.text : undefined,
    onGate: (permission) =>
      command(
        { kind: "gate", gate: permission },
        undefined,
        "Permission gate changed.",
        "This block's permission gate could not be changed. Nothing was changed.",
      ) === undefined,
    onReaction: props.onReaction,
  });
  // The reference settings point at the fields of the data the block reads, or, for a block that
  // reads none, at the application's own fields.
  const fieldsInUse = useMemo(
    () => studioFormFieldsInUseFor(props.context, props.selection),
    [props.context, props.selection],
  );
  const choices = useMemo(
    () => ({ ...studioBlockChoices(props.choices, settingsInputs.query), fieldsInUse }),
    [props.choices, settingsInputs.query, fieldsInUse],
  );
  // The query sheet answers after the draft changed: it chooses through the latest settings.
  const chooseQuery = useRef<(reference: string) => void>(() => undefined);
  const editSettings = useRef<(next: SettingsInputs) => void>(() => undefined);
  // Adding records from a list opens a create form, so the form is chosen before the switch appears.
  const addsFromList =
    settingsModel.kind === "available" &&
    settingsModel.properties.some((property) => property.key === "inline_create") &&
    settingsModel.properties.some((property) => property.key === "create_page");
  const createPageSetting = settingsInputs.settings.create_page;
  const inlineCreateSetting = settingsInputs.settings.inline_create;
  const createForm = createPageSetting?.kind === "page_reference" ? createPageSetting.page : "";
  const addsRecords = inlineCreateSetting?.kind === "boolean" && inlineCreateSetting.value;
  // The data's own refusal shows at its field; every other problem stays in the group's alert.
  const otherProblem = settings.problem.replace(chooseDataProblem, "").trim();
  const queryProblem =
    problemArea === "settings" && settings.problem.includes(chooseDataProblem)
      ? chooseDataProblem
      : undefined;
  // The data a block reads is the first field of its inspector: its bindings and the add-records
  // control follow it, because what it offers decides what the later controls offer.
  const queryValue = useMemo(
    () =>
      settingsModel.kind !== "available" || !settingsModel.readsQuery
        ? undefined
        : {
            value: settingsInputs.query ?? "",
            queries: props.choices.queries,
            recordQueries: props.choices.recordQueries ?? noQueries,
            problem: queryProblem,
            onChange: (reference: string) => chooseQuery.current(reference),
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
              onChange: (value: SourceBlockPropertyValueContract) =>
                editSettings.current({
                  ...settingsInputs,
                  settings: { ...settingsInputs.settings, query_parameters: value },
                }),
            },
            after: addsFromList ? (
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
                  editSettings.current({ ...settingsInputs, settings });
                }}
              />
            ) : undefined,
          },
    [
      settingsModel,
      settingsInputs,
      props.choices.queries,
      props.choices.recordQueries,
      props.onNewQuery,
      props.context,
      props.disabled,
      queryProblem,
      addsFromList,
      createForm,
      addsRecords,
      choices.pages,
    ],
  );

  // The selection bindings and the group's refusal follow the settings; the value keeps its identity
  // until one of them changes, so the fields of the inspector do not draw again for nothing.
  const showProblem = otherProblem !== "" && problemArea === "settings";
  const settingsAfter = useMemo(() => {
    if (settingsModel.kind !== "available") return undefined;
    const selectionBindings = (["open_with", "record_from"] as const).filter((key) =>
      settingsModel.properties.some((property) => property.key === key),
    );
    if (selectionBindings.length === 0 && !showProblem) return undefined;
    return (
      <>
        {selectionBindings.map((key) => (
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
              editSettings.current({ ...settingsInputs, settings: next });
            }}
          />
        ))}
        {showProblem && (
          <Alert variant="destructive">
            <AlertDescription>{otherProblem}</AlertDescription>
          </Alert>
        )}
      </>
    );
  }, [
    settingsModel,
    settingsInputs,
    props.context,
    props.choices.queries,
    props.disabled,
    showProblem,
    otherProblem,
  ]);

  const settingsNotice =
    settingsModel.kind === "available"
      ? undefined
      : settingsModel.kind === "unsupported"
        ? "This item's settings can't be changed here."
        : "This item's settings can't be read.";
  // A success is announced to a screen reader, in both the full and the reduced inspector.
  const announcement = (
    <p role="status" aria-live="polite" className="sr-only">
      {message.failed ? "" : message.text}
    </p>
  );
  if (model.kind !== "available") {
    // The block's header and who sees it stay; only its settings, order and size are unavailable.
    const placementAlias =
      props.selection.kind === "placement" ? props.selection.placementAlias : "";
    return (
      <section aria-labelledby={titleId}>
        <StudioBlockSettingFields
          titleId={titleId}
          choices={choices}
          disabled={props.disabled}
          placementAlias={placementAlias}
          name={studioPlacementLabel(labels, placementAlias) ?? "Block"}
          actions={[]}
          releases={props.context.catalogue.releases}
          access={access}
          layout={layoutValue}
          notice={settingsNotice ?? "This item's settings can't be changed here."}
        />
        {conditionDialog}
        {announcement}
      </section>
    );
  }

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
  const orderEditable = breakpoint === "desktop" || model.responsiveOrder;
  const selectedIndex = model.order.indexOf(model.placementAlias);
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
        ? [chooseDataProblem]
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
      ) === undefined
    )
      settings.applied(next);
    else settings.hold(next, "");
  };
  editSettings.current = (next) => changeSettings(next);
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
      <StudioBlockSettingFields
        titleId={titleId}
        choices={choices}
        disabled={props.disabled}
        placementAlias={model.placementAlias}
        name={studioPlacementLabel(labels, model.placementAlias) ?? "Block"}
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
        releases={props.context.catalogue.releases}
        query={queryValue}
        access={access}
        layout={layoutValue}
        settingsAfter={settingsAfter}
        notice={settingsNotice}
      />
      {conditionDialog}
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
      {announcement}
      {message.failed && message.area === "settings" && (
        <Alert key={message.at} variant="destructive">
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}
