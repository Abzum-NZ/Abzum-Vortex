"use client";

import { useId } from "react";
import { ArrowDown, ArrowUp, Undo2 } from "lucide-react";
import { Alert, AlertDescription } from "../components/alert";
import { FieldLegend } from "../components/field";
import { Input } from "../components/input";
import { Switch } from "../components/switch";
import { Icon } from "../icons";
import type {
  StudioCompositionEditorModel,
  StudioCompositionLayout,
} from "./application-composition-model";
import { studioScreens, useStudioScreen } from "./studio-canvas-screen";
import { StudioIconButton } from "./studio-entry-list";
import { StudioField, StudioHelp } from "./studio-field";
import { StudioSegmentedControl } from "./studio-segmented-control";
import { useStudioDraftHeld } from "./use-studio-draft-held";

/**
 * The Layout group's two fields: the size of the selected block on the screen the canvas shows, and
 * its place in the order of that screen. Neither is a prop of the block: they read the inspector's
 * layout value and write through its resize and order commands, so the draft, Undo and the canvas
 * see them as any other edit.
 */

/**
 * What the Layout fields need from the inspector: the block's model at the canvas screen, and the
 * commands that change its size and order.
 */
export type StudioLayoutFieldValue =
  | Readonly<{
      kind: "available";
      model: Extract<StudioCompositionEditorModel, { kind: "available" }>;
      /** The name the outline gives a block of this area. */
      labelOf: (alias: string) => string;
      /**
       * Sets the size on this screen (null returns it to the larger screen's); answers the
       * refusal's words, or undefined once the draft took it.
       */
      onResize: (layout: StudioCompositionLayout | null) => string | undefined;
      /**
       * Sets the order on this screen (null returns it to the larger screen's); answers as
       * onResize.
       */
      onOrder: (order: readonly string[] | null) => string | undefined;
      /** Moves the block one place on this screen; answers as onResize. */
      onMove: (direction: -1 | 1) => string | undefined;
      /**
       * Why the draft refused the last order change; the inspector clears it when the draft
       * changes.
       */
      orderProblem?: string | undefined;
    }>
  | Readonly<{ kind: "refused"; reason: string }>;

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

/** The problem of each input that keeps the inputs from the draft. */
const layoutProblems = (
  inputs: LayoutInputs,
): Readonly<{ start?: string; span?: string; height?: string }> => {
  const units = Number(inputs.units);
  const grid = inputs.width === "grid";
  return {
    ...(grid && columnNumber(inputs.startColumn) === undefined
      ? { start: "Columns are whole numbers from 1 to 12." }
      : {}),
    ...(grid && columnNumber(inputs.span) === undefined
      ? { span: "Columns are whole numbers from 1 to 12." }
      : {}),
    ...(inputs.height === "bounded" &&
    (inputs.units.trim() === "" || !Number.isFinite(units) || units < 0)
      ? { height: "A fixed height is a number of zero or more." }
      : {}),
  };
};

/** The layout the inputs describe, or the problem that keeps them from the draft. */
const layoutOf = (
  inputs: LayoutInputs,
): Readonly<{ layout: StudioCompositionLayout } | { problem: string }> => {
  const found = [...new Set(Object.values(layoutProblems(inputs)))];
  if (found.length > 0) return { problem: found.join(" ") };
  const start = columnNumber(inputs.startColumn);
  const span = columnNumber(inputs.span);
  return {
    layout: {
      visible: inputs.visible,
      width:
        inputs.width === "grid"
          ? { kind: "grid", start_column: start!, span: span! }
          : inputs.width === "content"
            ? { kind: "content" }
            : { kind: "fill" },
      height:
        inputs.height === "bounded"
          ? { kind: "bounded", units: Number(inputs.units) }
          : { kind: "content" },
    } as StudioCompositionLayout,
  };
};

/** Whether the block can move up and down in the order of the screen the canvas shows. */
export const studioOrderMoves = (
  model: Extract<StudioCompositionEditorModel, { kind: "available" }>,
  breakpoint: string,
): Readonly<{ up: boolean; down: boolean }> => {
  const index = model.order.indexOf(model.placementAlias);
  const editable = breakpoint === "desktop" || model.responsiveOrder;
  return {
    up: editable && index > 0,
    down: editable && index >= 0 && index < model.order.length - 1,
  };
};

/** The Layout group's one-line summary while it is closed: the screen and the width on it. */
export const studioLayoutSummary = (
  value: StudioLayoutFieldValue | undefined,
  breakpoint: string,
): string | undefined => {
  if (value?.kind !== "available") return undefined;
  const { layout } = value.model;
  const width =
    layout.width.kind === "fill"
      ? "Full width"
      : layout.width.kind === "content"
        ? "Fits content"
        : `${layout.width.span} columns`;
  return `${breakpoint.charAt(0).toUpperCase()}${breakpoint.slice(1)} · ${width}`;
};

/** The screen, visibility, width and height of the selected block. */
export function StudioLayoutField({
  value,
  disabled,
}: Readonly<{ value: StudioLayoutFieldValue; disabled: boolean }>) {
  const { breakpoint, choose: chooseScreen } = useStudioScreen();
  const model = value?.kind === "available" ? value.model : null;
  // Input that is not valid yet stays in its control; the draft changing under it (Undo, Redo,
  // another screen size) drops it.
  const held = useStudioDraftHeld(model === null ? null : inputsFor(model.layout));
  if (value.kind === "refused" || model === null || held.value === null)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {value.kind === "refused" ? value.reason : "This item is not in the current draft."}
      </p>
    );
  const inputs = held.value;
  // A problem with an input is said at that input; a refusal by the draft stands under the fields.
  const problems = held.problem === "" ? {} : layoutProblems(inputs);
  const refusal = Object.keys(problems).length === 0 ? held.problem : "";
  const change = (next: LayoutInputs) => {
    const described = layoutOf(next);
    if ("problem" in described) {
      held.hold(next, described.problem);
      return;
    }
    const reason = value.onResize(described.layout);
    if (reason === undefined) held.applied(next);
    else held.hold(next, reason);
  };
  return (
    <div className="space-y-4" data-vortex-layout-field>
      <StudioField label="Screen size">
        {() => (
          <StudioSegmentedControl
            label="Screen size"
            value={breakpoint}
            disabled={disabled}
            onChange={chooseScreen}
            options={studioScreens.map((screen) => ({
              value: screen.breakpoint,
              label: screen.label,
              icon: <Icon name={screen.icon} />,
            }))}
          />
        )}
      </StudioField>
      <fieldset className="space-y-4" disabled={disabled}>
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
            disabled={disabled || !model.capabilities.responsiveVisibility}
            onCheckedChange={(checked) => change({ ...inputs, visible: checked })}
          />
        </label>
        <StudioField label="Width">
          {() => (
            <StudioSegmentedControl
              label="Width"
              value={inputs.width}
              disabled={disabled}
              onChange={(width) => change({ ...inputs, width })}
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
            <StudioField label="Starts at column" error={problems.start}>
              {(control) => (
                <Input
                  {...control}
                  className="w-full"
                  type="number"
                  required
                  min={1}
                  max={12}
                  step={1}
                  value={inputs.startColumn}
                  onChange={(event) => change({ ...inputs, startColumn: event.target.value })}
                />
              )}
            </StudioField>
            <StudioField label="Number of columns" error={problems.span}>
              {(control) => (
                <Input
                  {...control}
                  className="w-full"
                  type="number"
                  required
                  min={1}
                  max={12}
                  step={1}
                  value={inputs.span}
                  onChange={(event) => change({ ...inputs, span: event.target.value })}
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
              disabled={disabled}
              onChange={(height) => change({ ...inputs, height })}
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
          <StudioField label="Fixed height" error={problems.height}>
            {(control) => (
              <Input
                {...control}
                className="w-full"
                type="number"
                required
                min={0}
                step="any"
                value={inputs.units}
                onChange={(event) => change({ ...inputs, units: event.target.value })}
              />
            )}
          </StudioField>
        )}
        {refusal !== "" && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{refusal}</AlertDescription>
          </Alert>
        )}
        {breakpoint !== "desktop" && (
          <StudioIconButton
            label="Use the larger screen's size"
            disabled={disabled || !model.explicitLayout}
            onClick={() => {
              const reason = value.onResize(null);
              if (reason !== undefined) held.hold(inputs, reason);
            }}
          >
            <Undo2 />
          </StudioIconButton>
        )}
      </fieldset>
    </div>
  );
}

/**
 * The selected block among its neighbours on the canvas screen, and the way back to the larger
 * screen's order.
 */
export function StudioOrderField({
  value,
  disabled,
}: Readonly<{ value: StudioLayoutFieldValue; disabled: boolean }>) {
  const { breakpoint } = useStudioScreen();
  const hintId = useId();
  if (value.kind !== "available") return null;
  const { model } = value;
  const editable = breakpoint === "desktop" || model.responsiveOrder;
  const moves = studioOrderMoves(model, breakpoint);
  return (
    <fieldset
      className="space-y-2"
      disabled={disabled || !editable}
      aria-describedby={hintId}
      data-vortex-order-field
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
            <span className="truncate">{value.labelOf(alias)}</span>
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-1">
        <StudioIconButton
          label="Move up"
          disabled={!moves.up}
          onClick={() => void value.onMove(-1)}
        >
          <ArrowUp />
        </StudioIconButton>
        <StudioIconButton
          label="Move down"
          disabled={!moves.down}
          onClick={() => void value.onMove(1)}
        >
          <ArrowDown />
        </StudioIconButton>
        {breakpoint !== "desktop" && (
          <StudioIconButton
            label="Use the larger screen's order"
            disabled={!model.explicitOrder}
            onClick={() => void value.onOrder(null)}
          >
            <Undo2 />
          </StudioIconButton>
        )}
      </div>
      {value.orderProblem !== undefined && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{value.orderProblem}</AlertDescription>
        </Alert>
      )}
    </fieldset>
  );
}
