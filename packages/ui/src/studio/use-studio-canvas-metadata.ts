import { useMemo } from "react";
import type { StudioCanvasModel } from "./studio-canvas-model";
import type { StudioCanvasMetadata, StudioCanvasFrameMetadata } from "./studio-canvas-metadata";
import type { StudioPuckInput } from "./studio-puck-provider";
import { useStudioCanvasRecords } from "./use-studio-canvas-records";

const NO_COMPILED_SETTINGS: StudioCanvasMetadata["compiled"] = Object.freeze({});

/** The part of Puck's `metadata` that is Studio's: what its blocks draw from and report to. */
export type StudioCanvasMetadataPart = Pick<
  StudioCanvasMetadata,
  "compiled" | "records" | "viewer" | "controls" | "grid" | "frame"
>;

/**
 * Studio's part of the canvas metadata, in one place. Compiled settings come from the open page's
 * model; the records are read for the saved revision (only while the canvas is on show, and only
 * for the visible page); the controls and the grid report back into the same reads; the frame is
 * the application the page is drawn in. The object changes only when one of its parts does, so
 * blocks draw again only for a real change.
 */
export const useStudioCanvasMetadata = (
  input: StudioPuckInput,
  model: StudioCanvasModel,
): StudioCanvasMetadataPart => {
  const { records, controls, grid } = useStudioCanvasRecords({
    area: model.area,
    areaKey: model.at?.key ?? "",
    readRecords: input.readRecords,
    catalogue: model.catalogue,
    compiledSource: input.compiledSource,
    originalSlot: model.originalSlot,
    slot: model.slot,
    // Records are read for the page the canvas shows: once it is on show with its compiled version
    // and frame, never before, so one read serves the final revision.
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
  const { platformThemeTokens, frame, appearance } = input;
  const empty = model.slot?.items.length === 0;
  const frameMetadata = useMemo(
    (): StudioCanvasFrameMetadata | null =>
      platformThemeTokens === null
        ? null
        : {
            frame,
            appearance,
            platformThemeTokens,
            empty,
          },
    [frame, appearance, platformThemeTokens, empty],
  );
  const viewer = input.viewer ?? null;
  const compiled = model.compiledSettings ?? NO_COMPILED_SETTINGS;
  return useMemo(
    () => ({ compiled, records, viewer, controls, grid, frame: frameMetadata }),
    [compiled, records, viewer, controls, grid, frameMetadata],
  );
};
