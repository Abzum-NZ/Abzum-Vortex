"use client";

import { useId, useState } from "react";
import { Alert, AlertDescription } from "../components/alert";
import { Button } from "../components/button";
import { FieldLegend } from "../components/field";
import { Input } from "../components/input";
import { Switch } from "../components/switch";
import { Icon } from "../icons";
import type {
  StudioCompositionEditorModel,
  StudioCompositionLayout,
} from "./application-composition-model";
import { studioScreens, useStudioScreen } from "./studio-canvas-screen";
import { StudioField, StudioHelp } from "./studio-field";
import { StudioSegmentedControl } from "./studio-segmented-control";
import { useStudioDraftHeld } from "./use-studio-draft-held";

/**
 * The Layout group's two fields: the size of the selected block on the screen the canvas shows, and
 * its place in the order of that screen. Neither is a prop of the block: they read the inspector's
 * layout value and write through its resize and order commands, so the draft, Undo and the canvas
 * see them as any other edit.
 */

/** What the Layout fields need from the inspector: the block's model at the canvas screen, and the two commands. */
export type StudioLayoutFieldValue =
  | Readonly<{
      kind: "available";
      model: Extract<StudioCompositionEditorModel, { kind: "available" }>;
      /** The name the outline gives a block of this area. */
      labelOf: (alias: string) => string;
      /** Sets the size on this screen (null returns it to the larger screen's); the refusal's words, or undefined once the draft took it. */
      onResize: (layout: StudioCompositionLayout | null) => string | undefined;
      /** Sets the order on this screen (null returns it to the larger screen's); the refusal's words, or undefined once the draft took it. */
      onOrder: (order: readonly string[] | null) => string | undefined;
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
  const columnsProblem = held.problem.startsWith("Columns") ? held.problem : undefined;
  const heightProblem = held.problem.startsWith("A fixed height") ? held.problem : undefined;
  const spanInvalid = columnsProblem !== undefined && columnNumber(inputs.span) === undefined;
  const refusal = columnsProblem === undefined && heightProblem === undefined ? held.problem : "";
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
            <StudioField label="Starts at column" error={spanInvalid ? undefined : columnsProblem}>
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
            <StudioField label="Number of columns" error={spanInvalid ? columnsProblem : undefined}>
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
          <StudioField label="Fixed height" error={heightProblem}>
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
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || !model.explicitLayout}
            onClick={() => {
              const reason = value.onResize(null);
              if (reason !== undefined) held.hold(inputs, reason);
            }}
          >
            <Icon name="undo" />
            Use the larger screen&apos;s size
          </Button>
        )}
      </fieldset>
    </div>
  );
}

/** The selected block among its neighbours on the canvas screen, and the way back to the larger screen's order. */
export function StudioOrderField({
  value,
  disabled,
}: Readonly<{ value: StudioLayoutFieldValue; disabled: boolean }>) {
  const { breakpoint } = useStudioScreen();
  const hintId = useId();
  // A refusal belongs to the order it was made against: any change of the order drops it.
  const [refused, setRefused] = useState<Readonly<{ on: string; text: string }> | null>(null);
  if (value.kind !== "available") return null;
  const { model } = value;
  const editable = breakpoint === "desktop" || model.responsiveOrder;
  const orderKey = `${breakpoint}:${model.explicitOrder}:${model.order.join(",")}`;
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
      {breakpoint !== "desktop" && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!model.explicitOrder}
          onClick={() => {
            const text = value.onOrder(null);
            if (text !== undefined) setRefused({ on: orderKey, text });
          }}
        >
          <Icon name="undo" />
          Use the larger screen&apos;s order
        </Button>
      )}
      {refused?.on === orderKey && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{refused.text}</AlertDescription>
        </Alert>
      )}
    </fieldset>
  );
}
