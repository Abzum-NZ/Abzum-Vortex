import { useMemo, useRef } from "react";
import { sameCompositionValue } from "./composition-references";
import type { StudioCanvasModel } from "./studio-canvas-model";
import type { StudioCanvasChannel, StudioCanvasFrameMetadata } from "./studio-canvas-metadata";
import type { StudioCanvasReferences } from "./studio-canvas-permissions";
import type { StudioPuckInput } from "./studio-puck-provider";
import { useStudioCanvasRecords } from "./use-studio-canvas-records";

/**
 * The value from an earlier render while the new one holds the same data. A value that is the
 * same object costs nothing; a new object is compared once, not written out as text.
 */
const useStableValue = <T>(value: T): T => {
  const held = useRef<{ value: T } | null>(null);
  if (held.current === null || !sameCompositionValue(held.current.value, value))
    held.current = { value };
  return held.current.value;
};

const NO_COMPILED_SETTINGS: StudioCanvasChannel["compiled"] = Object.freeze({});

/**
 * What the canvas draws from that grows with the page, in one place (`StudioCanvasChannel`, not
 * Puck's `metadata`, which Puck walks once per block). Compiled settings come from the open page's
 * model; the records are read for the saved revision (only while the canvas is on show, and only
 * for the visible page or layout); the controls and the grid report back into the same reads; the frame is
 * the application the page is drawn in. The object changes only when one of its parts does, so
 * blocks draw again only for a real change.
 */
export const useStudioCanvasChannelValue = (
  input: StudioPuckInput,
  model: StudioCanvasModel,
  references: StudioCanvasReferences,
): StudioCanvasChannel => {
  const { records, controls, grid } = useStudioCanvasRecords({
    area: model.area,
    areaKeys: model.zoneKeyList,
    readRecords: input.readRecords,
    catalogue: model.catalogue,
    compiledSource: input.compiledSource,
    originalItems: model.originalItems,
    items: model.items,
    // Records are read for what the canvas shows, a page or a layout: once it is on show with its
    // compiled version and frame, never before, so one read serves the final revision.
    visible:
      input.canvasShown &&
      model.shown !== undefined &&
      input.platformThemeTokens !== null &&
      input.fieldInputControlReleases !== null,
    gridReads: input.gridReads,
    onGridChange: input.onGridChange,
    arrangeGrid: input.arrangeGrid === true,
    updating: input.updating === true,
    compileFailure: input.compileFailure,
  });
  const { platformThemeTokens, appearance } = input;
  // The frame is derived from the whole draft (its menu follows the pages), so it is a new object
  // after every edit; it is only a change to the canvas when its content is.
  const frame = useStableValue(input.frame);
  const frameMetadata = useMemo(
    (): StudioCanvasFrameMetadata | null =>
      platformThemeTokens === null
        ? null
        : {
            frame,
            appearance,
            platformThemeTokens,
            slotKeys: model.slotKeys,
            layout: model.owner === "layout",
          },
    [frame, appearance, platformThemeTokens, model.slotKeys, model.owner],
  );
  const viewer = input.viewer ?? null;
  const compiled = model.compiledSettings ?? NO_COMPILED_SETTINGS;
  return useMemo(
    () => ({
      compiled,
      references,
      contentTargets: model.contentTargets,
      records,
      viewer,
      controls,
      grid,
      frame: frameMetadata,
    }),
    [compiled, references, model.contentTargets, records, viewer, controls, grid, frameMetadata],
  );
};
